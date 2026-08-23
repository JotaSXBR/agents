import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { DocumentField } from "@/modules/documents/blocks";
import { issueDocument } from "@/modules/documents/issue";
import { failableTool, toolFailure } from "./failure";
import type { TurnState } from "./native";

// One tool per document template the agent was granted. The tool ISSUES the document and queues it
// for delivery in the same call, because issuing and sending are one act from the customer's side:
// splitting them would cost a second model round-trip and open a window where a numbered document
// exists and nobody was told about it.
//
// The tool's ARGUMENTS are derived from the template's declared `fields`, which is the whole point of
// declaring them: the operator writes the contract once, in the console or over MCP, and the model
// sees exactly that contract — no free-form JSON, no field the renderer would drop.

export interface DocumentSelection {
  templateId: bigint;
  name: string;
  slug: string;
  description: string | null;
  fields: DocumentField[];
}

export interface DocumentToolDeps {
  tenantId: bigint;
  turnState?: TurnState;
  // The conversation's own thread key (tenant:instance:conversation). Absent off a real conversation
  // (playground, nudge), and the document is then issued unbound rather than guessed onto a
  // conversation id, which only identifies a conversation WITHIN one Chatwoot account.
  threadId?: string;
  chatwootInstanceId?: bigint | null;
  conversationDbId?: bigint | null;
  base?: PrismaClient;
  storageDir?: string;
  // The agent's own IANA zone (from its business hours). It decides the calendar day the document is
  // DATED — a document issued at 22:00 in São Paulo is 01:00 UTC the next day, and the customer must
  // not receive a quote dated tomorrow.
  timezone?: string;
  toolInstructions?: Record<string, string>;
}

const FIELD_HINT: Record<DocumentField["type"], string> = {
  text: "",
  number: "",
  currency:
    'Amount in the document\'s currency, as a number (1299.90, not "R$ 1.299,90").',
  date: "ISO date, YYYY-MM-DD.",
  lineItems:
    "One entry per line of the table. Never add them up: the document computes its own totals.",
};

function fieldSchema(field: DocumentField): z.ZodTypeAny {
  const described = (schema: z.ZodTypeAny) => {
    const hint = FIELD_HINT[field.type];
    const text = [field.label, field.description, hint]
      .filter(Boolean)
      .join(" — ");
    return schema.describe(text);
  };
  switch (field.type) {
    case "text":
      return described(z.string());
    case "number":
    case "currency":
      return described(z.number());
    case "date":
      return described(z.string());
    case "lineItems":
      return described(
        z.array(
          z.object({
            description: z.string(),
            quantity: z.number(),
            unitPrice: z.number(),
          }),
        ),
      );
  }
}

export function documentToolSchema(fields: DocumentField[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const schema = fieldSchema(field);
    shape[field.name] = field.required ? schema : schema.optional();
  }
  return z.object(shape);
}

// Same values, same document. Derived from the thread and the values rather than taken as an
// argument, so a retried turn — the model repeating itself, the graph resuming — reuses the row
// instead of putting a second numbered document in front of one customer.
function idempotencyKey(
  templateId: bigint,
  threadId: string | undefined,
  values: unknown,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(values ?? {}));
  return `doc:${templateId}:${threadId ?? "unbound"}:${hasher.digest("hex").slice(0, 32)}`;
}

// The text a MODEL wrote into the document, for the output guardrail to screen alongside the reply.
// Only strings, because that is where policy-bearing text can be: a price or a date carries none, and
// feeding numbers to a moderation pass costs tokens for nothing. Line-item descriptions are included
// because a line on a quote is a sentence the customer reads.
export function screenableValues(input: Record<string, unknown>): string {
  const out: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const description = (item as { description?: unknown } | null)
        ?.description;
      if (typeof description === "string") out.push(description);
    }
  }
  return out.join("\n");
}

export function buildDocumentTools(
  selections: DocumentSelection[],
  deps: DocumentToolDeps,
): StructuredToolInterface[] {
  return selections.map((selection) => {
    const name = `send_${selection.slug}`;
    const guidance = deps.toolInstructions?.[name];
    const description =
      `Issue and send the customer a "${selection.name}" as a PDF attached to your reply.` +
      (selection.description ? ` ${selection.description}` : "") +
      " The document is generated from the template the operator authored, numbered, and attached to this turn's answer — so say what you are sending, and do not restate the prices in text unless the customer asked for them there." +
      (guidance ? `\n\n${guidance}` : "");

    return failableTool(
      async (input: Record<string, unknown>) => {
        // Queued, not sent, for the same reason as send_image: delivery happens after the turn's
        // gates, so a superseded, taken-over or blocked turn must not have already put a priced
        // document in front of the customer.
        const turnState = deps.turnState;
        if (!turnState) {
          return "Não é possível anexar um documento neste momento (mensagem proativa). Diga ao cliente que ele será enviado na conversa.";
        }
        // AT MOST ONE document per turn, across every document tool. The file is ours and small, so
        // the byte budget send_image carries buys nothing here, while two priced documents in one
        // message is the actual failure mode.
        //
        // The slot is taken BEFORE the await, like send_image's, and for a sharper reason: one model
        // response's tool calls run under Promise.all, so a check that only reads the QUEUE is read
        // by every call in the batch while the queue is still empty. All of them would pass, all of
        // them would issue — a numbered row and a rendered PDF each — and all but one would then be
        // thrown away, leaving documents on the tenant's list that were never sent and that nobody
        // can account for.
        //
        // Released in `finally`, so a refusal does not burn the turn. The model is told what to fix
        // and its corrected call arrives in the same turn; on the way out the queue carries the
        // claim instead.
        if (
          turnState.documentsInFlight > 0 ||
          turnState.pendingAttachments.some((a) => a.kind === "document")
        ) {
          return "Um documento já vai junto com a sua resposta deste turno. Envie o próximo em outra mensagem.";
        }
        turnState.documentsInFlight++;
        const order = turnState.attachmentsSeq++;
        try {
          const issued = await issueDocument({
            tenantId: deps.tenantId,
            templateId: selection.templateId,
            idempotencyKey: idempotencyKey(
              selection.templateId,
              deps.threadId,
              input,
            ),
            values: input,
            threadId: deps.threadId ?? null,
            chatwootInstanceId: deps.chatwootInstanceId ?? null,
            conversationId: deps.conversationDbId ?? null,
            withBytes: true,
            base: deps.base,
            storageDir: deps.storageDir,
            timezone: deps.timezone,
          });
          if (!issued.bytes) {
            return toolFailure(
              "Não consegui gerar o documento agora. Ofereça encaminhar para um atendente.",
            );
          }
          turnState.pendingAttachments.push({
            bytes: issued.bytes,
            mime: "application/pdf",
            fileName: issued.fileName,
            order,
            tool: name,
            kind: "document",
            screenText: screenableValues(input),
            documentId: BigInt(issued.id),
          });
          // NOTE: no field values here, and no customer name. This string is the tool's OUTPUT, and
          // ToolFlowLogger stores tool outputs verbatim in `ExecutionLog.detail` — a column that
          // carries no customer data. The number is ours and identifies nobody.
          return `Documento ${issued.number} pronto; ele vai junto com a sua resposta deste turno.`;
        } catch (e) {
          // A rejected argument is the model's to fix and it has the message to do it with — normal
          // operation, not an integration failure. Anything else (storage gone, render crashed) is
          // the operator's problem and has to reach the alert channels.
          if (e instanceof AppError && e.statusCode === 400) {
            return `Não consegui emitir o documento: ${e.message} Corrija os dados e tente de novo, ou siga a conversa sem prometer o envio.`;
          }
          // The document cannot be produced and no argument change would alter that: either the
          // operator voided it (and the key that identifies it comes from these very values, so
          // "try again" lands back on the same row), or the template it counts from is gone. Both
          // are decisions someone made, not failures of ours, so neither goes to the alert channels.
          if (e instanceof AppError && e.statusCode === 409) {
            return "Não é possível enviar esse documento. Siga a conversa sem prometer o envio, ou ofereça encaminhar para um atendente.";
          }
          throw e;
        } finally {
          turnState.documentsInFlight--;
        }
      },
      { name, description, schema: documentToolSchema(selection.fields) },
    );
  });
}
