import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildNativeTools, type TurnState } from "@/graph/tools/native";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { generateQuote, loadQuoteForDelivery } from "@/modules/quotes/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #21. `POST /v1/quotes` rendered a PDF and stored it, and the only way to read it back was a
// route behind a tenant credential — which the customer will never hold. These tests are about the
// two halves of closing that: which quote a conversation is allowed to send, and the fact that the
// tool QUEUES it rather than posting it mid-turn.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const DIR = `/tmp/fazerai-send-quote-${process.pid}`;
const SNAPSHOT = {
  title: "Orçamento mensal",
  currency: "BRL",
  items: [{ description: "Plano", quantity: 1, unitPrice: 199.9 }],
};

let tenantId = 0n;
let otherTenantId = 0n;
let instanceA = 0n;
let instanceB = 0n;

// Conversation numbers. `SHARED` exists on BOTH instances of the same tenant on purpose: a Chatwoot
// conversation id is unique per ACCOUNT, and that is the whole reason a quote is not matched on it.
const CONV = 4001;
const CONV_REVISED = 4002;
const CONV_UNMIRRORED = 4003;
const SHARED = 4004;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}
function thread(instance: bigint, conv: number): string {
  return `${tenantId}:${instance}:${conv}`;
}

async function seedConversation(instance: bigint, conv: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instance,
      chatwootConversationId: conv,
      status: "open",
      threadId: thread(instance, conv),
      lastEventAt: new Date(),
    },
  });
}

// A conversation of its own per test: the rule under test is "the thread's LATEST quote", so tests
// that shared a thread would be reading each other's leftovers instead of their own fixture.
let convSeq = 4100;
async function freshConversation(): Promise<number> {
  const conv = convSeq++;
  await seedConversation(instanceA, conv);
  return conv;
}

async function quoteFor(conv: number, key: string) {
  return generateQuote({
    tenantId,
    idempotencyKey: key,
    snapshot: SNAPSHOT,
    conversationId: BigInt(conv),
    base: appDb,
    storageDir: DIR,
  });
}

// Records what would reach the customer, so a test can tell "queued" from "sent".
function stubClient(sent: string[]): ChatwootClient {
  return {
    sendFileAttachment: async (
      _conversationId: number,
      _bytes: ArrayBuffer,
      fileName: string,
    ) => {
      sent.push(fileName);
      return null;
    },
  } as unknown as ChatwootClient;
}

function emptyTurn(): TurnState {
  return {
    resolveRequested: false,
    pendingAttachments: [],
    imagesInFlight: 0,
    attachmentsSeq: 0,
  };
}

function sendQuote(
  conv: number,
  over: {
    turnState?: TurnState;
    threadId?: string;
    sent?: string[];
  } = {},
): StructuredToolInterface | undefined {
  const tools = buildNativeTools(
    {
      client: stubClient(over.sent ?? []),
      conversationId: conv,
      tenantId,
      threadId:
        over.threadId === undefined ? thread(instanceA, conv) : over.threadId,
      base: appDb,
      quotesStorageDir: DIR,
      turnState: over.turnState,
    },
    ["send_quote"],
  );
  return tools.find((t) => t.name === "send_quote");
}

describe.skipIf(!dbUp)("sending a quote to the customer", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "QuoteSend", slug: `quote-send-${process.pid}` },
    });
    tenantId = t.id;
    const o = await suDb.tenant.create({
      data: { name: "QuoteOther", slug: `quote-other-${process.pid}` },
    });
    otherTenantId = o.id;
    const a = await seedChatwootInstance(suDb, { tenantId, accountId: 1 });
    instanceA = a.id;
    const b = await seedChatwootInstance(suDb, { tenantId, accountId: 2 });
    instanceB = b.id;
    for (const conv of [CONV, CONV_REVISED]) {
      await seedConversation(instanceA, conv);
    }
    // The same number on two accounts of one tenant: the ambiguity the thread key exists to refuse.
    await seedConversation(instanceA, SHARED);
    await seedConversation(instanceB, SHARED);
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM quotes WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  describe("a quote's binding to a conversation", () => {
    test("a mirrored conversation gives the quote the thread delivery matches on", async () => {
      const q = await quoteFor(CONV, "bind-1");
      const row = await suDb.quote.findUniqueOrThrow({
        where: { id: BigInt(q.id) },
        select: { threadId: true, conversationId: true },
      });
      expect(row.threadId).toBe(thread(instanceA, CONV));
      // The caller's own id is kept as written: it is what the console shows, and it is NOT what
      // delivery matches on.
      expect(row.conversationId).toBe(BigInt(CONV));
    });

    // Fail-closed, and this is the case that would otherwise hand one lead's prices to another. A
    // Chatwoot conversation id is unique per account; a tenant running two accounts has two
    // conversations numbered 4004, belonging to two different people.
    test("a conversation number that two accounts share leaves the quote unbound", async () => {
      const q = await quoteFor(SHARED, "bind-shared");
      const row = await suDb.quote.findUniqueOrThrow({
        where: { id: BigInt(q.id) },
        select: { threadId: true },
      });
      expect(row.threadId).toBeNull();
      // And it is therefore deliverable to NEITHER of them, rather than to whichever came first.
      for (const inst of [instanceA, instanceB]) {
        const found = await loadQuoteForDelivery(
          ctx(tenantId),
          thread(inst, SHARED),
          appDb,
          DIR,
        );
        expect(found.ok).toBe(false);
      }
    });

    test("a conversation that was never mirrored leaves the quote unbound", async () => {
      const q = await quoteFor(CONV_UNMIRRORED, "bind-unmirrored");
      const row = await suDb.quote.findUniqueOrThrow({
        where: { id: BigInt(q.id) },
        select: { threadId: true },
      });
      expect(row.threadId).toBeNull();
    });

    test("a caller who names the thread outright is believed", async () => {
      const q = await generateQuote({
        tenantId,
        idempotencyKey: "bind-explicit",
        snapshot: SNAPSHOT,
        conversationId: BigInt(CONV_UNMIRRORED),
        threadId: thread(instanceA, CONV),
        base: appDb,
        storageDir: DIR,
      });
      const row = await suDb.quote.findUniqueOrThrow({
        where: { id: BigInt(q.id) },
        select: { threadId: true },
      });
      expect(row.threadId).toBe(thread(instanceA, CONV));
    });
  });

  describe("which quote the conversation may send", () => {
    test("the thread's own quote comes back with its bytes and its file name", async () => {
      const conv = await freshConversation();
      const q = await quoteFor(conv, "load-1");
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, conv),
        appDb,
        DIR,
      );
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.id).toBe(q.id);
      expect(found.fileName).toBe(`quote-${q.id}.pdf`);
      expect(
        Buffer.from(new Uint8Array(found.bytes))
          .subarray(0, 5)
          .toString("latin1"),
      ).toBe("%PDF-");
    });

    test("a conversation with no quote says so", async () => {
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, 999999),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "none" });
    });

    // The rule that matters most here. A revised quote REPLACES the one before it, so a newest row
    // that cannot go out is a refusal — never a reason to reach back for the price the operator just
    // replaced, silently, at the moment the customer is deciding on it.
    test("a revoked newest quote refuses instead of falling back to the one it replaced", async () => {
      const older = await quoteFor(CONV_REVISED, "revised-old");
      const newer = await quoteFor(CONV_REVISED, "revised-new");
      expect(BigInt(newer.id) > BigInt(older.id)).toBe(true);
      await suDb.quote.update({
        where: { id: BigInt(newer.id) },
        data: { revoked: true },
      });
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, CONV_REVISED),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "revoked" });
    });

    test("an expired quote is named as expired", async () => {
      const conv = await freshConversation();
      const q = await quoteFor(conv, "load-expired");
      await suDb.quote.update({
        where: { id: BigInt(q.id) },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, conv),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "expired" });
    });

    test("a quote still rendering is named as such", async () => {
      const conv = await freshConversation();
      const row = await suDb.quote.create({
        data: {
          tenantId,
          conversationId: BigInt(conv),
          threadId: thread(instanceA, conv),
          idempotencyKey: "load-pending",
          status: "PENDING",
          snapshot: SNAPSHOT,
        },
        select: { id: true },
      });
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, conv),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "not_rendered" });
      await suDb.quote.delete({ where: { id: row.id } });
    });

    // The operator's problem, not the model's: the row is fine and the storage the PDF lived on is
    // not. It is the one refusal the tool reports as an integration failure.
    test("a READY quote whose file is gone is a missing file, not a missing quote", async () => {
      const conv = await freshConversation();
      const q = await quoteFor(conv, "load-nofile");
      await rm(`${DIR}/${tenantId}/${q.id}.pdf`, { force: true });
      const found = await loadQuoteForDelivery(
        ctx(tenantId),
        thread(instanceA, conv),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "missing_file" });
    });

    // The thread key already carries the tenant id, so a cross-tenant read cannot even be spelled by
    // accident. The scoped read is what makes that a fence rather than a naming convention.
    test("another tenant reading the same thread key finds nothing", async () => {
      const conv = await freshConversation();
      await quoteFor(conv, "load-fence");
      const found = await loadQuoteForDelivery(
        ctx(otherTenantId),
        thread(instanceA, conv),
        appDb,
        DIR,
      );
      expect(found).toEqual({ ok: false, reason: "none" });
    });
  });

  describe("the send_quote tool", () => {
    // It QUEUES: delivery belongs to the post-turn pipeline, after the ownership recheck, the
    // supersede gate and the output guardrail. A priced document posted from inside the graph
    // invocation can reach a customer whose turn is then discarded.
    test("queues the PDF instead of sending it mid-turn", async () => {
      const conv = await freshConversation();
      const q = await quoteFor(conv, "tool-queue");
      const sent: string[] = [];
      const turnState = emptyTurn();
      const out = await sendQuote(conv, { turnState, sent })?.invoke({});
      expect(String(out)).toContain("Orçamento pronto para envio");
      expect(sent).toEqual([]);
      expect(turnState.pendingAttachments).toHaveLength(1);
      expect(turnState.pendingAttachments[0]).toMatchObject({
        fileName: `quote-${q.id}.pdf`,
        mime: "application/pdf",
        tool: "send_quote",
      });
    });

    test("declines when there is no turn to queue into", async () => {
      const conv = await freshConversation();
      await quoteFor(conv, "tool-noturn");
      const out = await sendQuote(conv, { turnState: undefined })?.invoke({});
      expect(String(out)).toContain("mensagem proativa");
    });

    // No thread means the quote could not be bound to one conversation — the ambiguous or unmirrored
    // case. Declining is the whole point of resolving it fail-closed at generation.
    test("declines when the conversation has no thread key", async () => {
      const conv = await freshConversation();
      await quoteFor(conv, "tool-nothread");
      const turnState = emptyTurn();
      const out = await sendQuote(conv, { turnState, threadId: "" })?.invoke(
        {},
      );
      expect(String(out)).toContain("Não é possível anexar");
      expect(turnState.pendingAttachments).toHaveLength(0);
    });

    test("tells the model what to do instead when the quote was revoked", async () => {
      const conv = await freshConversation();
      const q = await quoteFor(conv, "tool-revoked");
      await suDb.quote.update({
        where: { id: BigInt(q.id) },
        data: { revoked: true },
      });
      const turnState = emptyTurn();
      const out = await sendQuote(conv, { turnState })?.invoke({});
      expect(String(out)).toContain("cancelado pela equipe");
      expect(turnState.pendingAttachments).toHaveLength(0);
    });

    // One model response's tool calls run under Promise.all, so both calls read an empty queue
    // before either has pushed. The check that holds is the one after the await, with no await
    // between it and the push.
    test("a batch that asks twice still attaches one copy", async () => {
      const conv = await freshConversation();
      await quoteFor(conv, "tool-batch");
      const turnState = emptyTurn();
      const tool = sendQuote(conv, { turnState });
      const outs = await Promise.all([tool?.invoke({}), tool?.invoke({})]);
      expect(turnState.pendingAttachments).toHaveLength(1);
      expect(
        outs.filter((o) => String(o).includes("já vai junto")),
      ).toHaveLength(1);
    });
  });
});
