import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  processChatwootDelivery,
  receiveChatwootWebhook,
} from "@/modules/chatwoot/webhook";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

// /reset drives real ChatwootClient calls (the command path builds its own client — no injectable
// factory reaches it), so the double here is `globalThis.fetch` shaped like a Chatwoot server.
//
// It AUTHENTICATES like one, which is the whole point: Chatwoot's AccessTokenAuthHelper leaves
// @access_token nil for a blank header and authenticate_access_token! renders 401 before any
// authorization runs. A stub that accepts any token is what let issue #79 ship — /reset built its
// client without a bot token, every bot-token call 401'd, and the customer was still told the
// conversation had been cleared.

const BOT_TOKEN = "BOT-TOKEN";
const ADMIN_TOKEN = "ADMIN-TOKEN";
const CONV_ID = 42;
const INBOX_ID = 7;
const KANBAN_TASK_ID = 55;
const CONTACT_CW_ID = 808;
const WIDGET_INBOX_ID = 8;

interface CwCall {
  method: string;
  path: string;
  token: string;
  body: unknown;
}

interface FakeChatwoot {
  calls: CwCall[];
  impl: typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// `failing` marks endpoints that answer 500 even with a valid token, so a test can drive a partial
// failure without going through the auth path.
function fakeChatwoot(failing: RegExp | null = null): FakeChatwoot {
  const calls: CwCall[] = [];
  const impl = (async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = new Headers(init?.headers).get(CHATWOOT_AUTH_HEADER) ?? "";
    const raw = init?.body;
    calls.push({
      method,
      path: url.pathname,
      token,
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    if (token.trim() === "") {
      return jsonResponse({ error: "Invalid Access Token" }, 401);
    }
    if (failing?.test(url.pathname))
      return jsonResponse({ error: "boom" }, 500);
    if (
      method === "GET" &&
      url.pathname.endsWith(`/conversations/${CONV_ID}`)
    ) {
      return jsonResponse({ id: CONV_ID, kanban_task: { id: KANBAN_TASK_ID } });
    }
    // The account's attribute schema. `crm_id` is deliberately absent from it: it is the key an
    // integration owns, and the one a wholesale clear would destroy.
    if (
      method === "GET" &&
      url.pathname.endsWith("/custom_attribute_definitions")
    ) {
      return jsonResponse([
        {
          attribute_key: "orcamento",
          attribute_model: "contact_attribute",
          attribute_display_name: "Orçamento",
          attribute_display_type: "text",
        },
        {
          attribute_key: "qualificado",
          attribute_model: "contact_attribute",
          attribute_display_name: "Qualificado",
          attribute_display_type: "text",
        },
        {
          attribute_key: "produto",
          attribute_model: "conversation_attribute",
          attribute_display_name: "Produto",
          attribute_display_type: "text",
        },
      ]);
    }
    if (
      method === "GET" &&
      url.pathname.endsWith(`/contacts/${CONTACT_CW_ID}`)
    ) {
      return jsonResponse({
        payload: {
          id: CONTACT_CW_ID,
          custom_attributes: {
            orcamento: "5000",
            qualificado: "sim",
            crm_id: "CRM-9",
          },
        },
      });
    }
    return jsonResponse({ id: 1 });
  }) as typeof fetch;
  return { calls, impl };
}

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

const SECRET = "reset-webhook-secret";
let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";
let deliverySeq = 0;
const originalFetch = globalThis.fetch;

// Drives one incoming message through the receiver and the processor, exactly as a live delivery
// would. Defaults to the /reset this suite is named for.
async function sendReset(
  content = "/reset",
  convId = CONV_ID,
  // The conversation as CHATWOOT has it when the command arrives. Defaults to the bot-owned shape;
  // the handoff case sends the one a human is holding, which is the state the command has to undo.
  live: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number;
    // The bot whose webhook ROUTE the delivery arrives on. Chatwoot fans a message out to the
    // conversation's assigned bot AND the inbox's, so these are not always the same persona.
    routeToken?: string;
    testActivated?: boolean;
    // Omit `meta` entirely: the payload then says nothing about ownership and the mirror's stored
    // trio is what the gate reads, which is how a real degraded event behaves.
    silentMeta?: boolean;
    // The inbox the delivery names. The mirror follows it, so a test that seeds a conversation on
    // another inbox has to say so here or the row is moved back to the default one.
    inboxId?: number;
    // A stand-in Prisma client, for driving a failure into one specific query.
    base?: PrismaClient;
  } = {},
): Promise<void> {
  deliverySeq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_created",
    id: 9000 + deliverySeq,
    content,
    message_type: "incoming",
    private: false,
    conversation: {
      id: convId,
      inbox_id: live.inboxId ?? INBOX_ID,
      status: live.status ?? "pending",
      contact_inbox: { id: 301 },
      ...(live.silentMeta ? {} : { meta: undefined }),
      meta: live.silentMeta
        ? undefined
        : (live.assigneeType ?? null) === null
          ? { assignee_type: null, assignee: null }
          : {
              assignee_type: live.assigneeType,
              assignee: {
                id: live.assigneeId ?? 77,
                type: live.assigneeType,
              },
            },
    },
  });
  const r = await receiveChatwootWebhook({
    routeToken: live.routeToken ?? routeToken,
    rawBody: body,
    getHeader: (name: string) =>
      ({
        "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
          .update(`${nowSeconds}.${body}`)
          .digest("hex")}`,
        "x-chatwoot-timestamp": String(nowSeconds),
        "x-chatwoot-delivery": `reset-${deliverySeq}`,
      })[name.toLowerCase()] ?? null,
    nowSeconds,
    base: appDb,
  });
  await processChatwootDelivery({
    tenantId,
    instanceId: r.instanceId as bigint,
    deliveryRowId: r.deliveryRowId as bigint,
    agentBotId: r.agentBotId ?? null,
    normalized: r.normalized as NonNullable<typeof r.normalized>,
    base: live.base ?? appDb,
  });
}

const attributeCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.path.endsWith("/custom_attributes"));
const ackCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));

describe.skipIf(!dbUp)(
  "/reset clears through an authenticated bot client",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Reset", slug: `reset-${process.pid}` },
      });
      tenantId = t.id;
      const { token, hash } = generateRouteToken();
      routeToken = token;
      // TEST-NET-3 (RFC 5737, reserved for documentation) on the discard port: an IP literal keeps the
      // SSRF guard off DNS, and the address is public enough to pass its blocked-range check. Nothing is
      // dialed either way — globalThis.fetch is the double.
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://203.0.113.10:9",
        adminToken: encryptJson(ADMIN_TOKEN),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "x",
          mode: "test",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "WhatsApp",
          agentId: agent.id,
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Atendente",
        },
      });
      const contact = await suDb.contact.create({
        data: { tenantId, chatwootContactId: CONTACT_CW_ID, name: "Cliente" },
      });
      // Test mode must already be ACTIVE for this conversation, or /reset defers to the silence gate.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          contactId: contact.id,
          chatwootConversationId: CONV_ID,
          contactInboxId: 301,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
          testActivatedAt: new Date(),
        },
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    });

    test("the custom-attributes call carries the persona bot's token, so the clear lands", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const attrs = attributeCalls(cw.calls);
      expect(attrs).toHaveLength(1);
      // The defect: this token was "" and Chatwoot answered 401, so the attributes survived the reset.
      expect(attrs[0]?.token).toBe(BOT_TOKEN);
      expect(attrs[0]?.body).toEqual({ custom_attributes: {} });
    });

    // The compacted memory of past attendances lives in its own table, not in the graph thread, so
    // deleting the thread alone would leave it behind — and the next compaction renders it back into
    // the thread's first message. A /reset that says "memória" and resurrects it is a lie.
    test("the compacted memory of past attendances is cleared too", async () => {
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 999,
          lastMessageId: "msg-abc",
          summary: "orçamento de R$ 250 aprovado",
          messageCount: 4,
          attendanceAt: new Date(),
        },
      });
      // A compaction armed on a resolve waits out a grace window, so at any moment there can be one
      // sitting in the queue holding this very conversation. Left armed it fires minutes later and
      // writes a fresh row: memory the operator explicitly deleted, back with no trace of where it
      // came from.
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
          runAt: new Date(Date.now() + 600_000),
          status: "PENDING",
          payload: {},
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
      const job = await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
        },
      });
      // cancelPendingJob retires a row as DONE (its vocabulary for "this will not run").
      expect(job?.status).toBe("DONE");
    });

    // The checkpoint is the one piece of the memory that a compaction can RECREATE. Deleted outside
    // the lock the rewrite holds, the order that loses is: reset deletes the thread, the claimed job
    // finishes its rewrite and writes the checkpoint back — with the memory head in it — and reset
    // then takes the lock and deletes rows that no longer describe what the agent can see. The
    // operator is told the memory was cleared and the agent keeps answering from it.
    //
    // Held from another connection, the lock proves the ordering directly: while it is held, nothing
    // of the memory may be gone.
    test("the checkpoint is deleted under the lock, not before it", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      const cp = await getCheckpointer();
      await buildThreadStateGraph(cp).updateState(
        { configurable: { thread_id: threadId } },
        { messages: [new HumanMessage("orçamento de R$ 250 aprovado")] },
        THREAD_STATE_NODE,
      );
      const read = () => cp.get({ configurable: { thread_id: threadId } });
      expect(await read()).toBeTruthy();
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 998,
          lastMessageId: "msg-lock",
          summary: "orçamento aprovado",
          messageCount: 2,
          attendanceAt: new Date(),
        },
      });

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      const survived: boolean[] = [];
      // Kept OUT of the transaction's return value on purpose: returning it would make Prisma await
      // the reset before committing, and the reset is waiting on the lock that commit releases.
      let running: Promise<void> = Promise.resolve();
      let resetFailed: unknown;
      // The memory step is the FIRST of the reset, so it blocks here almost immediately.
      await suDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ingest:${threadId}`})::bigint)`;
        running = sendReset().catch((err) => {
          resetFailed = err;
        });
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 50));
          survived.push(Boolean(await read()));
        }
      });
      await running;
      expect(resetFailed).toBeUndefined();

      expect(survived.every(Boolean)).toBe(true);
      expect(await read()).toBeUndefined();
      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
    });

    test("a failed step does not skip the independent ones that follow it", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(attributeCalls(cw.calls)).toHaveLength(1);
      // Labels, attributes and the kanban card are independent cleanups. Sharing one try meant the
      // first failure swallowed the rest, and the card kept the previous episode's dates.
      expect(
        cw.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels")),
      ).toBe(true);
      expect(
        cw.calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`),
        ),
      ).toBe(true);
    });

    test("a failure on the last remote step still leaves the local cleanups done", async () => {
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        data: { testNoticeSentAt: new Date(), lastFollowUpAt: new Date() },
      });
      const cw = fakeChatwoot(/\/kanban\/tasks\//);
      globalThis.fetch = cw.impl;
      await sendReset();

      // The kanban card is the last Chatwoot call, but the watermark clear comes after it. Unguarded,
      // its failure would throw past everything below, including the ack.
      const conv = await suDb.conversation.findUniqueOrThrow({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        select: { testNoticeSentAt: true, lastFollowUpAt: true },
      });
      expect(conv.testNoticeSentAt).toBeNull();
      expect(conv.lastFollowUpAt).toBeNull();
      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toMatch(/kanban/i);
    });

    // Building the persona client reads the DB and resolves DNS through the SSRF guard, so it throws on
    // its own during an outage. Outside the best-effort boundary that abandoned the whole reset after
    // the memory had already been wiped, leaving no acknowledgement at all.
    test("a client that cannot even be built does not abandon the local cleanups", async () => {
      const other = await suDb.tenant.create({
        data: { name: "ResetBlocked", slug: `reset-blocked-${process.pid}` },
      });
      try {
        const { token, hash } = generateRouteToken();
        // http + loopback: refused by the SSRF guard before any request is attempted.
        const inst = await seedChatwootInstance(suDb, {
          tenantId: other.id,
          accountId: 1,
          baseUrl: "http://127.0.0.1:9",
          adminToken: encryptJson(ADMIN_TOKEN),
        });
        const agent = await suDb.agent.create({
          data: {
            tenantId: other.id,
            name: "Atendente",
            systemPrompt: "x",
            mode: "test",
          },
        });
        const inbox = await suDb.inbox.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: INBOX_ID,
            name: "WhatsApp",
            agentId: agent.id,
          },
        });
        await suDb.chatwootAgentBot.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            agentId: agent.id,
            chatwootAgentBotId: 9,
            accessToken: encryptJson(BOT_TOKEN),
            webhookSecret: encryptJson(SECRET),
            webhookRouteTokenHash: hash,
            name: "Atendente",
          },
        });
        await suDb.conversation.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            inboxId: inbox.id,
            chatwootConversationId: CONV_ID,
            contactInboxId: 302,
            status: "pending",
            threadId: `${other.id}:${inst.id}:${CONV_ID}`,
            testActivatedAt: new Date(),
            testNoticeSentAt: new Date(),
            lastFollowUpAt: new Date(),
          },
        });

        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const body = JSON.stringify({
          event: "message_created",
          id: 9500,
          content: "/reset",
          message_type: "incoming",
          private: false,
          conversation: {
            id: CONV_ID,
            inbox_id: INBOX_ID,
            status: "pending",
            contact_inbox: { id: 302 },
            meta: { assignee_type: null, assignee: null },
          },
        });
        const r = await receiveChatwootWebhook({
          routeToken: token,
          rawBody: body,
          getHeader: (name: string) =>
            ({
              "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
                .update(`${nowSeconds}.${body}`)
                .digest("hex")}`,
              "x-chatwoot-timestamp": String(nowSeconds),
              "x-chatwoot-delivery": "reset-blocked",
            })[name.toLowerCase()] ?? null,
          nowSeconds,
          base: appDb,
        });
        await processChatwootDelivery({
          tenantId: other.id,
          instanceId: r.instanceId as bigint,
          deliveryRowId: r.deliveryRowId as bigint,
          agentBotId: r.agentBotId ?? null,
          normalized: r.normalized as NonNullable<typeof r.normalized>,
          base: appDb,
        });

        // Nothing could be sent (the ack shares the same blocked base URL), but the local slate is
        // still clean and the run reached the end instead of dying halfway.
        expect(cw.calls).toHaveLength(0);
        const conv = await suDb.conversation.findUniqueOrThrow({
          where: {
            tenantId_chatwootInstanceId_chatwootConversationId: {
              tenantId: other.id,
              chatwootInstanceId: inst.id,
              chatwootConversationId: CONV_ID,
            },
          },
          select: { testNoticeSentAt: true, lastFollowUpAt: true },
        });
        expect(conv.testNoticeSentAt).toBeNull();
        expect(conv.lastFollowUpAt).toBeNull();
      } finally {
        await suDb.tenant.delete({ where: { id: other.id } }).catch(() => {});
      }
    });

    // The one survivor that makes every other one moot. `shouldBotHandle` needs BOTH
    // `status === "pending"` and `assignee_type !== "User"`, and /reset used to touch neither: the
    // canonical test loop (activate with /teste, let the agent hand off, resolve, start over) ended
    // with a conversation that announces itself as active and then never answers. The only thing
    // that fixed it was "Devolver para IA" in the console, which is behind a login the client
    // running the test usually does not have.
    test("a conversation a human took over is returned to the agent", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      // Pending BEFORE unassign, which is the order returnConversationToAgent documents, and it is
      // chosen for the failure: the two are separate requests, and the partial that leaves the human
      // holding the conversation is recoverable by doing nothing, while the one that removes them
      // and leaves a status the gate refuses is nobody's conversation.
      const owned = cw.calls.filter(
        (c) =>
          c.method === "POST" &&
          (c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
            c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`)),
      );
      expect(owned.map((c) => [c.path.split("/").pop(), c.body])).toEqual([
        ["toggle_status", { status: "pending" }],
        ["assignments", { assignee_id: 0 }],
      ]);
      // Admin token on both: the bot cannot reassign a conversation away from a human, and the
      // audit should show the operator rather than the persona.
      expect(owned.every((c) => c.token === ADMIN_TOKEN)).toBe(true);

      // And the mirror agrees, so the very next delivery passes the gate instead of waiting for a
      // Chatwoot event that may never come.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { status: true, assigneeType: true, assigneeId: true },
      });
      expect(conv).toEqual({
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });

      // The acknowledgement reports what happened and nothing else: the conversation WAS handed
      // back, so the sentence that explains withholding it has no business here.
      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(ack).not.toContain("desativado");
    });

    // The other way the conversation can still be a human's when the reset ends: the assignment call
    // itself failed. The command has to name THAT — a partial reset — and not the switch, which is on.
    test("a failed hand-back is reported as a failure, not as a disabled agent", async () => {
      const cw = fakeChatwoot(/\/assignments$/);
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(ack).toContain("atribuição");
      expect(ack).not.toContain("desativado");
    });

    // And what that ordering buys. The status call failing must leave the human where they were, not
    // strip the conversation from them and hand it to a gate that refuses it.
    test("a hand-back that fails halfway leaves the human holding it", async () => {
      const cw = fakeChatwoot(/\/toggle_status$/);
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      // The unassign never ran, so nothing was taken away.
      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
      // And the operator is told which part did not happen.
      expect(
        ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" "),
      ).toContain("atribuição");
    });

    // The other half of the same rule: asked with `shouldBotHandle` so an ordinary reset does not
    // spend two admin calls undoing nothing. Without this the condition is unobservable — making the
    // return unconditional passes every other test in this file.
    test("a reset on a bot-owned conversation does not touch the assignment", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        cw.calls.filter(
          (c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
            c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`),
        ),
      ).toEqual([]);
    });

    // WHEN the conversation goes back to the agent, which is a different question from whether it
    // does. Returning it is what makes the NEXT delivery actionable, so a customer message arriving
    // while the cleanup is still running would pass the gate and start a turn on the episode this
    // command is halfway through erasing. The assignment is therefore the LAST thing the reset
    // touches — everything before it runs while the human still holds the conversation.
    test("the conversation goes back to the agent only after the episode is cleared", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      const assignmentAt = cw.calls.findIndex((c) =>
        c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
      );
      expect(assignmentAt).toBeGreaterThan(-1);
      // Every cleanup call the command makes, by the endpoint it lands on. The acknowledgement is
      // excluded on purpose: it is the one thing that SHOULD come after the return.
      const cleanupAt = cw.calls
        .map((c, i) => [c, i] as const)
        .filter(
          ([c]) =>
            c.path.endsWith("/custom_attributes") ||
            c.path.endsWith("/labels") ||
            c.path.includes("/kanban/tasks/") ||
            (c.method === "PUT" && c.path.includes("/contacts/")),
        )
        .map(([, i]) => i);
      expect(cleanupAt.length).toBeGreaterThan(0);
      expect(Math.max(...cleanupAt)).toBeLessThan(assignmentAt);
    });

    // The redirect gate's anchors, which /reset ignored while clearing the three notice watermarks
    // right next to them. Same shape, same purpose, opposite treatment: once the redirect has fired,
    // `redirectCount` is at its cap and the cooldown anchor is set, so the operator who resets to run
    // the funnel again gets a conversation that will never redirect.
    test("the redirect watermarks are cleared, so the funnel can be run again", async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: {
          redirectSentAt: new Date(),
          redirectCount: 3,
          redirectLinkedAt: new Date(),
          redirectClosedAt: new Date(),
          lastError: "boom",
          lastErrorAt: new Date(),
          failureNoticeSentAt: new Date(),
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: {
          redirectSentAt: true,
          redirectCount: true,
          redirectLinkedAt: true,
          redirectClosedAt: true,
          lastError: true,
          lastErrorAt: true,
          failureNoticeSentAt: true,
        },
      });
      expect(conv).toEqual({
        redirectSentAt: null,
        // The count is a counter, not a timestamp: back to zero, not to null.
        redirectCount: 0,
        redirectLinkedAt: null,
        redirectClosedAt: null,
        // And the previous run's failure goes with it. `failureNoticeSentAt` is the coalescing
        // anchor for "a human has to take over", so after a reset a fresh failure has to be able to
        // announce itself again — the same reasoning that already clears testNoticeSentAt.
        lastError: null,
        lastErrorAt: null,
        failureNoticeSentAt: null,
      });
    });

    // Jobs the episode armed. /reset already cancels FOLLOWUP and MEMORY_COMPACT; these two carry
    // exactly the same argument and were left running.
    test("the jobs the episode armed are cancelled with it", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await suDb.schedulerJob.createMany({
        data: [
          {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${threadId}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { widgetThreadId: threadId },
          },
          {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-198:60",
            runAt: new Date(Date.now() + 3_600_000),
            payload: { threadId, eventId: "evt-198", calendarId: "c" },
          },
        ],
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const jobs = await suDb.schedulerJob.findMany({
        where: {
          tenantId,
          kind: { in: ["REDIRECT_FOLLOWUP", "APPOINTMENT_REMINDER"] },
        },
        select: { kind: true, status: true, payload: true },
        orderBy: { kind: "asc" },
      });
      expect(jobs.map((j) => [j.kind, j.status])).toEqual([
        ["APPOINTMENT_REMINDER", "DONE"],
        ["REDIRECT_FOLLOWUP", "DONE"],
      ]);
      // Cancelling alone is not enough for the reminder: `loadAppointmentContext` re-reads these
      // rows on EVERY turn and cannot tell a cancelled job from a fired one, so without the
      // tombstone the appointment block stays in the prompt after the reset.
      const reminder = jobs.find((j) => j.kind === "APPOINTMENT_REMINDER");
      expect(
        (reminder?.payload as { cancelledAt?: string })?.cancelledAt,
      ).toBeString();
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    });

    // The redirect funnel spans a PAIR of conversations, and the four tests below are about naming
    // it. `withRedirectPair` configures the agent's entry/widget inboxes, seeds the widget-side
    // conversation of the same contact, and undoes both afterwards — the agent is shared by every
    // test in this file, so the config cannot leak.
    const withRedirectPair = async (
      run: (widgetConvId: number, widgetThread: string) => Promise<void>,
      enabled = true,
    ): Promise<void> => {
      const mine = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { contactId: true, inbox: { select: { agentId: true } } },
      });
      const agentId = mine.inbox?.agentId as bigint;
      const widgetInbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: WIDGET_INBOX_ID,
          name: "Site",
          agentId,
        },
      });
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            channelRedirect: {
              enabled,
              entryInboxId: INBOX_ID,
              widgetInboxId: WIDGET_INBOX_ID,
            },
          },
        },
      });
      const widgetThread = `${tenantId}:${instanceId}:44`;
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: widgetInbox.id,
          contactId: mine.contactId,
          chatwootConversationId: 44,
          contactInboxId: 304,
          status: "pending",
          threadId: widgetThread,
        },
      });
      try {
        await run(44, widgetThread);
      } finally {
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 44 },
        });
        await suDb.inbox.delete({ where: { id: widgetInbox.id } });
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: {} },
        });
      }
    };

    // The ladder is keyed by the WIDGET thread, and its stages act on BOTH sides of the pair: stage 2
    // re-sends the link on the WhatsApp ENTRY conversation, stage 3 closes and resolves both. So the
    // entry conversation — which is where `redirectCount` lives, and therefore where the operator
    // re-runs the funnel from — cannot reach it by its own thread id. Cancelling only that key left
    // the previous episode's ladder free to message and resolve the conversation just cleared.
    test("the redirect ladder is cancelled from the entry side of the pair", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "closing", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        // Typed on the ENTRY conversation, whose own key was never enqueued.
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("DONE");
      });
    });

    // A ladder the worker had ALREADY picked up. Cancelling reaches PENDING rows only, so the row
    // survives — and this ladder's terminal stage posts a closing on both conversations and resolves
    // them, after the operator was told the episode was cleared. The stamp is what an in-flight
    // handler can see; the status is deliberately left alone, because the worker still owns the row.
    test("a ladder already claimed is tombstoned, not just skipped", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            status: "CLAIMED",
            runAt: new Date(),
            payload: { stage: "closing", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true, payload: true },
        });
        expect(job.status).toBe("CLAIMED");
        expect(
          (job.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeString();
      });
    });

    // The same pair, the other half of its state. `redirectClosedAt` is the CAS that makes the
    // closing deliver at most once, and it lives on the WIDGET row — so clearing only the row the
    // command was typed in left the funnel able to start again and unable to ever finish again:
    // deliverRedirectClosing returns `already-closed` and the ladder ends in silence.
    test("the paired conversation's redirect anchors are cleared too", async () => {
      await withRedirectPair(async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: {
            redirectLinkedAt: new Date(),
            redirectClosedAt: new Date(),
            // Not an anchor of the episode: this one describes the widget conversation itself and
            // the operator did not reset it.
            testNoticeSentAt: new Date(),
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 44 },
          select: {
            redirectLinkedAt: true,
            redirectClosedAt: true,
            testNoticeSentAt: true,
          },
        });
        expect(widget.redirectLinkedAt).toBeNull();
        expect(widget.redirectClosedAt).toBeNull();
        expect(widget.testNoticeSentAt).not.toBeNull();
      });
    });

    // The booking lives where the AI runs, and in a redirect episode that is never the entry
    // conversation: the gate answers there with a fixed message and no model, so every turn happens
    // in the widget. A reset typed on the entry side was cancelling reminders on a thread that had
    // never booked anything, and the test appointment kept nudging the customer.
    test("the appointment reminders of the widget side are cancelled too", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.schedulerJob.createMany({
          data: [
            {
              tenantId,
              kind: "APPOINTMENT_REMINDER",
              dedupeKey: "reminder:evt-widget:60",
              runAt: new Date(Date.now() + 3_600_000),
              payload: {
                threadId: widgetThread,
                eventId: "evt-widget",
                calendarId: "c",
              },
            },
            // And one on the ENTRY thread: reaching the sibling must not come at the cost of the
            // conversation the operator actually typed the command in.
            {
              tenantId,
              kind: "APPOINTMENT_REMINDER",
              dedupeKey: "reminder:evt-entry:60",
              runAt: new Date(Date.now() + 3_600_000),
              payload: {
                threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
                eventId: "evt-entry",
                calendarId: "c",
              },
            },
          ],
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        // Typed on the ENTRY conversation, which never booked anything.
        await sendReset();

        const jobs = await suDb.schedulerJob.findMany({
          where: { tenantId, kind: "APPOINTMENT_REMINDER" },
          select: { dedupeKey: true, status: true, payload: true },
          orderBy: { dedupeKey: "asc" },
        });
        expect(
          jobs.map((j) => [
            j.dedupeKey,
            j.status,
            (j.payload as { cancelledAt?: string })?.cancelledAt !== undefined,
          ]),
        ).toEqual([
          ["reminder:evt-entry:60", "DONE", true],
          ["reminder:evt-widget:60", "DONE", true],
        ]);
      });
    });

    // A funnel that is switched off has no episode, even with its inboxes still configured. The
    // command acts on the pair — it cancels the sibling's ladder and its appointment reminders — and
    // that is scheduled work belonging to another conversation. With the redirect off the two are
    // not a pair, they are two conversations of the same contact.
    test("a disabled funnel has no pair to reach", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { redirectClosedAt: new Date() },
        });
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "chat", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("PENDING");
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 44 },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).not.toBeNull();
      }, false);
    });

    // The fence on the widening. Contact ids are account-wide and a tenant can run several agents on
    // one Chatwoot instance, so "every ladder this contact is in" reaches a funnel nobody touched.
    // The pair is whatever THIS agent's config says it is.
    test("a reset leaves another agent's funnel for the same contact alone", async () => {
      await withRedirectPair(async () => {
        const mine = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { contactId: true },
        });
        const otherAgent = await suDb.agent.create({
          data: {
            tenantId,
            name: "Outro funil",
            systemPrompt: "x",
            settings: {
              channelRedirect: {
                enabled: true,
                entryInboxId: 10,
                widgetInboxId: 11,
              },
            },
          },
        });
        const otherWidget = await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 11,
            name: "Site do outro",
            agentId: otherAgent.id,
          },
        });
        const otherThread = `${tenantId}:${instanceId}:47`;
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: otherWidget.id,
            contactId: mine.contactId,
            chatwootConversationId: 47,
            contactInboxId: 307,
            status: "pending",
            threadId: otherThread,
          },
        });
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${otherThread}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "chat", widgetThreadId: otherThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("PENDING");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 47 },
        });
        await suDb.inbox.delete({ where: { id: otherWidget.id } });
        await suDb.agent.delete({ where: { id: otherAgent.id } });
      });
    });

    // The command names ONE conversation, and the pair it belongs to is that conversation's — not
    // any pair the same agent happens to run for the same contact. An agent can own a third inbox
    // (support, overflow), and a /reset typed there was silently resetting the funnel's two
    // conversations, which the operator never named.
    test("a reset outside the pair leaves the pair alone", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        const mine = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { contactId: true, inbox: { select: { agentId: true } } },
        });
        const thirdInbox = await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 12,
            name: "Suporte",
            agentId: mine.inbox?.agentId,
          },
        });
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: thirdInbox.id,
            contactId: mine.contactId,
            chatwootConversationId: 48,
            contactInboxId: 308,
            status: "pending",
            threadId: `${tenantId}:${instanceId}:48`,
            testActivatedAt: new Date(),
          },
        });
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { redirectClosedAt: new Date() },
        });
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "chat", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        // Typed on the THIRD conversation: neither side of the funnel.
        await sendReset("/reset", 48, { inboxId: 12 });

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("PENDING");
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 44 },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).not.toBeNull();
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 48 },
        });
        await suDb.inbox.delete({ where: { id: thirdInbox.id } });
      });
    });

    // The nullable half of that ordering. `lastEventAt` starts null and Postgres sorts NULLs FIRST on
    // a descending order, so a conversation that never carried an event outranks the live one — and
    // the side lookup then answers with a conversation that is not this one, `isEntry` goes false,
    // and the episode silently stops being recognised: sibling anchors kept, ladder still armed.
    test("a conversation that never carried an event does not outrank the live one", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        const mine = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { contactId: true, inboxId: true },
        });
        // Same contact, same ENTRY inbox, no activity at all.
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: mine.inboxId,
            contactId: mine.contactId,
            chatwootConversationId: 51,
            contactInboxId: 311,
            status: "resolved",
            threadId: `${tenantId}:${instanceId}:51`,
            lastEventAt: null,
          },
        });
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "chat", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("DONE");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 51 },
        });
      });
    });

    // Which conversation is "the widget side" when the contact has been through the funnel before.
    // The live one: an old widget conversation is a previous episode, and its ladder was retired when
    // it resolved. Picking it instead would cancel nothing and leave the running ladder armed.
    test("the pair resolves to the live conversation of each side", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 44 },
          select: { inboxId: true, contactId: true },
        });
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { lastEventAt: new Date(Date.now() - 86_400_000) },
        });
        // A newer widget conversation on the same inbox: this episode's real chat.
        const liveThread = `${tenantId}:${instanceId}:49`;
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: widget.inboxId,
            contactId: widget.contactId,
            chatwootConversationId: 49,
            contactInboxId: 309,
            status: "pending",
            threadId: liveThread,
            lastEventAt: new Date(),
          },
        });
        await suDb.schedulerJob.createMany({
          data: [
            {
              tenantId,
              kind: "REDIRECT_FOLLOWUP",
              dedupeKey: `redirect-followup:${liveThread}`,
              runAt: new Date(Date.now() + 3_600_000),
              payload: { stage: "chat", widgetThreadId: liveThread },
            },
            {
              tenantId,
              kind: "REDIRECT_FOLLOWUP",
              dedupeKey: `redirect-followup:${widgetThread}`,
              runAt: new Date(Date.now() + 3_600_000),
              payload: { stage: "chat", widgetThreadId: widgetThread },
            },
          ],
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const jobs = await suDb.schedulerJob.findMany({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { dedupeKey: true, status: true },
          orderBy: { dedupeKey: "asc" },
        });
        expect(
          jobs.find((j) => j.dedupeKey === `redirect-followup:${liveThread}`)
            ?.status,
        ).toBe("DONE");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 49 },
        });
      });
    });

    // And the fence one level out. A Contact is unique per TENANT, not per Chatwoot instance, so a
    // tenant running two accounts shares one contact row across both — and an inbox id repeats freely
    // between accounts. Without the instance predicate the pair resolves to the other account's
    // conversation, and the ladder key built from it names some unrelated conversation here.
    test("the pair does not reach the contact's other Chatwoot instance", async () => {
      await withRedirectPair(async () => {
        const mine = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { contactId: true },
        });
        // The widget side of THIS instance goes away, so the only candidate left is the other
        // account's — which is exactly what the predicate has to refuse.
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 44 },
        });
        const other = await seedChatwootInstance(suDb, {
          tenantId,
          accountId: 2,
          baseUrl: "https://203.0.113.11:9",
          adminToken: encryptJson(ADMIN_TOKEN),
        });
        const otherInbox = await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: other.id,
            chatwootInboxId: WIDGET_INBOX_ID,
            name: "Site da outra conta",
          },
        });
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: other.id,
            inboxId: otherInbox.id,
            contactId: mine.contactId,
            chatwootConversationId: 46,
            contactInboxId: 306,
            status: "pending",
            threadId: `${tenantId}:${other.id}:46`,
          },
        });
        // Conversation 46 of THIS instance is a different conversation entirely, and this is its
        // ladder.
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${tenantId}:${instanceId}:46`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { stage: "chat" },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset();

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true },
        });
        expect(job.status).toBe("PENDING");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 46 },
        });
        await suDb.inbox.delete({ where: { id: otherInbox.id } });
        await suDb.chatwootInstance.delete({ where: { id: other.id } });
      });
    });

    // And the opposite fence on the reminders. They are keyed `reminder:<eventId>:<offset>`, so the
    // command has to find them by the thread their payload carries — but going from that thread back
    // to the EVENT and cancelling the whole prefix reaches outside the conversation that typed the
    // command: a reschedule re-arms the surviving offsets with whichever conversation asked for it,
    // while already-fired rows keep the old thread. One reset would then retire a live reminder
    // belonging to a conversation nobody touched.
    test("the reminder cancellation stops at this conversation's thread", async () => {
      const mine = `${tenantId}:${instanceId}:${CONV_ID}`;
      const theirs = `${tenantId}:${instanceId}:45`;
      await suDb.schedulerJob.createMany({
        data: [
          {
            // Fired here, still carrying this thread: the row that names the event.
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-shared:1440",
            status: "DONE",
            runAt: new Date(Date.now() - 3_600_000),
            payload: { threadId: mine, eventId: "evt-shared", calendarId: "c" },
          },
          {
            // Same event, re-armed from ANOTHER conversation after a reschedule.
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-shared:60",
            runAt: new Date(Date.now() + 3_600_000),
            payload: {
              threadId: theirs,
              eventId: "evt-shared",
              calendarId: "c",
            },
          },
        ],
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const rows = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "APPOINTMENT_REMINDER" },
        select: { dedupeKey: true, status: true, payload: true },
        orderBy: { dedupeKey: "asc" },
      });
      expect(
        rows.map((r) => [
          r.dedupeKey,
          r.status,
          (r.payload as { cancelledAt?: string })?.cancelledAt !== undefined,
        ]),
      ).toEqual([
        // Ours: tombstoned even though it had already fired, because the appointment block is
        // rendered from these rows and cannot tell "cancelled" from "fired".
        ["reminder:evt-shared:1440", "DONE", true],
        // Theirs: untouched, still armed.
        ["reminder:evt-shared:60", "PENDING", false],
      ]);
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    });

    // The line between what this command owns and what it merely has a token for. The card belongs to
    // this conversation; the contact's Chatwoot attributes are the ACCOUNT's — shared with every
    // other conversation of every other agent, with no record of who wrote a key. An earlier round of
    // this change cleared every account-defined contact attribute and would have deleted an
    // operator's CRM field because someone typed /reset in a test conversation.
    test("the contact's Chatwoot attributes are not this command's to delete", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        cw.calls.filter(
          (c) =>
            c.method === "PUT" && c.path.endsWith(`/contacts/${CONTACT_CW_ID}`),
        ),
      ).toEqual([]);

      // What the command DOES own on the contact: our own column, written only by our own tool.
      const contact = await suDb.contact.findFirstOrThrow({
        where: { tenantId, chatwootContactId: CONTACT_CW_ID },
        select: { voiceReply: true },
      });
      expect(contact.voiceReply).toBeNull();

      // And the card's attributes, which have no such tension: the card belongs to this conversation.
      const card = cw.calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`) &&
          (c.body as { task?: { custom_attributes?: unknown } })?.task
            ?.custom_attributes !== undefined,
      );
      expect(card?.body).toEqual({ task: { custom_attributes: {} } });
    });

    // The instruction that was wrong exactly where the operator needed it. /teste lifts the
    // test-mode silence and nothing else, so on a conversation a human is holding it activates and
    // the agent still says nothing — and the notice told them to send /teste.
    test("the acknowledgement stops telling the operator to send a command that will not help", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/teste", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });
      // The acknowledgement lands as a PRIVATE note here, not a public message: `postPublicMessage`
      // withholds anything the bot no longer owns, which is right for the agent's own output and
      // would silently drop the one sentence explaining the silence.
      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      // Names no holder: a human, another persona's bot and a conversation left `open` all reach
      // here, and only "not with this agent" is true of all three.
      expect(ack).toContain("não está com este agente");
      expect(ack).toContain("/reset");
      expect(
        ackCalls(cw.calls).every(
          (c) => (c.body as { private?: boolean })?.private === true,
        ),
      ).toBe(true);

      const cw2 = fakeChatwoot();
      globalThis.fetch = cw2.impl;
      await sendReset("/teste");
      const ack2 = ackCalls(cw2.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      // Bot-owned: unchanged, and it must NOT name a command with nothing to undo.
      expect(ack2).toBe("🧪 Modo teste ativado para esta conversa.");
    });

    // A SECOND persona bound to the same instance, holding this conversation. Both ownership tests
    // below need the same three rows, and the shape is the load-bearing part: the conversation is
    // `pending` (shouldBotHandle rejects any other status BEFORE it compares bot ids, so an `open`
    // one answers "not ours" for a reason that has nothing to do with which bot is being asked
    // about), and the assignment lives in the MIRROR rather than in the payload, which is the
    // fallback a degraded event takes.
    const seedOtherPersonaHoldingIt = async (): Promise<{
      token: string;
      agentId: bigint;
    }> => {
      const { token, hash } = generateRouteToken();
      const otherAgent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Outra persona",
          systemPrompt: "x",
          mode: "test",
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: otherAgent.id,
          chatwootAgentBotId: 77,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Outra persona",
        },
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "pending", assigneeType: "AgentBot", assigneeId: 77 },
      });
      return { token, agentId: otherAgent.id };
    };

    // Which route runs the command. Chatwoot dispatches an incoming message to the conversation's
    // ASSIGNED agent bot AND to the inbox's, as two deliveries with two ids — so once commands
    // stopped being gated on ownership, both routes executed the same /reset: two runs, two
    // acknowledgements, and the second clearing state the first had just rebuilt.
    test("a command delivered on another bot's route is left to the inbox's persona", async () => {
      const { token: otherToken, agentId: otherAgentId } =
        await seedOtherPersonaHoldingIt();
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      // Assigned to bot 77, delivered on bot 77's route, while the inbox's persona is bot 9.
      await sendReset("/reset", CONV_ID, {
        status: "pending",
        silentMeta: true,
        routeToken: otherToken,
      });

      // Consumed and dropped: no reset, and no acknowledgement either — the run belongs to the other
      // delivery. Returning false here instead would hand "/reset" to this bot's agent as customer
      // text.
      expect(cw.calls).toEqual([]);
      await suDb.agent.delete({ where: { id: otherAgentId } });
    });

    // The other half: the inbox's own route DOES run it, on the very conversation the other bot
    // holds. Without this the fence above could be passing by refusing every route.
    test("the inbox's own route runs the command on a conversation another bot holds", async () => {
      const { agentId: otherAgentId } = await seedOtherPersonaHoldingIt();
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "pending",
        silentMeta: true,
      });

      expect(
        cw.calls
          .filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          )
          .map((c) => c.body),
      ).toEqual([{ assignee_id: 0 }]);
      await suDb.agent.delete({ where: { id: otherAgentId } });
    });

    // The agent switched off, restored afterwards: it is shared by every test in this file, so the
    // flag cannot leak.
    const withDisabledAgent = async (
      run: () => Promise<void>,
    ): Promise<void> => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      try {
        await run();
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    };

    // The switch is read the same way ownership is: FRESH, at the moment the hand-back is decided.
    // /reset asks after its cleanup, which is a dozen network calls long, so pairing a fresh
    // ownership read with the agent's state from the top of the function is exactly how the
    // conversation would still be handed to an agent an operator turned off while the command ran.
    // The Chatwoot double doubles as the rendezvous: the switch flips on the card call, mid-cleanup.
    test("the switch is re-read when the hand-back is decided, not before", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let flipped = false;
      globalThis.fetch = (async (input, init) => {
        if (!flipped && String(input).includes("/kanban/tasks/")) {
          flipped = true;
          await suDb.agent.update({
            where: { id: agentId },
            data: { enabled: false },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        expect(flipped).toBe(true);
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // And what a FAILED re-read decides: nothing. The fallback is the value the command already had,
    // because a transient database failure is not evidence that the operator turned the agent on.
    // The mutation this kills is the tempting one — a catch that answers "enabled" — which would hand
    // a human's conversation to a switched-off agent on a blip.
    test("a failed re-read of the switch does not answer for it", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      // Keyed on the SELECTION, not on a call count: the handler reads the agent twice before this
      // one (the inbox runtime and the command's own context lookup), both of which have to succeed
      // for the command to run at all, and both select more than one column. The re-read under test
      // is the only one that asks for `enabled` alone.
      let reads = 0;
      const flaky = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              if (Object.keys(sel).length === 1 && sel.enabled === true) {
                reads += 1;
                throw new Error("connection reset");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          base: flaky,
        });

        expect(reads).toBeGreaterThan(0);
        // Started disabled, the re-read failed, so the answer stays "disabled" and the human keeps
        // the conversation.
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // The ownership read is asked after the cleanup has already run, so a rejection there would lose
    // the acknowledgement for work that DID happen and leave the delivery mid-flight. Unknown
    // ownership answers `none`: the irreversible half (taking the conversation off a human) is the
    // one that must not fire on a guess.
    test("an ownership read that fails does not strand the command", async () => {
      const blind = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              // The fence's own read, identified by the three columns it asks for.
              if (
                Object.keys(sel).length === 3 &&
                sel.assigneeType === true &&
                sel.assigneeId === true &&
                sel.status === true
              ) {
                return Promise.reject(new Error("connection reset"));
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: blind,
      });

      // The command still reports what it did — including the sentence about the hand-back, whose
      // own ownership read is the second place this could have thrown after the cleanup.
      expect(ackCalls(cw.calls).length).toBeGreaterThan(0);
      // ...and did not take the conversation from the human on an answer it does not have.
      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
    });

    // The same guard on the OTHER late ownership read: the sentence that explains a withheld
    // hand-back asks the question again, after everything has run. It reaches that line only while
    // the agent is disabled, which is why the failure has to be driven with the switch off.
    test("a disabled agent still acknowledges when ownership cannot be read", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      const blind = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              if (
                Object.keys(sel).length === 3 &&
                sel.assigneeType === true &&
                sel.assigneeId === true &&
                sel.status === true
              ) {
                return Promise.reject(new Error("connection reset"));
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          base: blind,
        });

        expect(ackCalls(cw.calls).length).toBeGreaterThan(0);
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // And the row being GONE, which is the other thing a re-read can find. Deleting the agent while
    // the command runs is narrow, but the answer has to be the same one the loud case gets: nothing
    // can answer here, so the human keeps the conversation.
    test("an agent that no longer exists does not get the conversation either", async () => {
      const vanished = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              // Promise.resolve, not a bare null: Prisma awaits whatever the hook returns, and a
              // plain null makes it throw — which would land in the catch and prove the wrong branch.
              if (Object.keys(sel).length === 1 && sel.enabled === true)
                return Promise.resolve(null);
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: vanished,
      });

      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
    });

    test("a disabled agent does not get a conversation a human is holding", async () => {
      await withDisabledAgent(async () => {
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        expect(
          cw.calls.filter(
            (c) =>
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
              c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`),
          ),
        ).toEqual([]);
        // The memory clear still ran — this is a reset, not a refusal.
        expect(
          cw.calls.some((c) => c.path.endsWith("/custom_attributes")),
        ).toBe(true);
        // And the operator is told, because the assignment is the one part they can see not happening.
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("desativado");
        expect(ack).toContain("continua com quem a atendia");
      });
    });

    // The same question in the two texts that answer it. Naming /reset to an operator whose agent is
    // switched off is the round-1 defect one layer deeper: the command runs and still cannot help.
    test("a disabled agent names no command it cannot honour", async () => {
      await withDisabledAgent(async () => {
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/teste", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("desativado");
        expect(ack).not.toContain("/reset");

        // And on a conversation the agent DOES own: the switch still decides. "Modo teste ativado"
        // on its own would be the round-1 defect restated — activation is not the same as being
        // able to answer, and here nothing can. Ownership is set explicitly, because with it absent
        // the two reasons agree and the test would prove nothing about which one is asked first.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
        const cw2 = fakeChatwoot();
        globalThis.fetch = cw2.impl;
        await sendReset("/teste");
        expect(
          ackCalls(cw2.calls)
            .map((c) => (c.body as { content?: string })?.content ?? "")
            .join(" "),
        ).toContain("desativado");
      });
    });

    // And the third text that answers it: the one-shot note on a conversation nobody ever activated.
    // It has one shot, so naming the wrong reason there costs the operator every later chance.
    test("the un-activated notice names the switch, not the assignment", async () => {
      await withDisabledAgent(async () => {
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: (
              await suDb.inbox.findFirstOrThrow({
                where: { tenantId, chatwootInboxId: INBOX_ID },
                select: { id: true },
              })
            ).id,
            chatwootConversationId: 50,
            contactInboxId: 310,
            status: "open",
            threadId: `${tenantId}:${instanceId}:50`,
            testActivatedAt: null,
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", 50, { status: "open", assigneeType: "User" });

        const notes = cw.calls
          .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(notes).toContain("desativado");
        expect(notes).not.toContain("/reset");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 50 },
        });
      });
    });

    // The notice fires only while the conversation was NEVER activated, and /reset needs
    // `testActivatedAt` to run at all — so naming /reset alone would send the operator down the same
    // no-op path, and the one-shot watermark would then suppress any second chance to tell them.
    test("the un-activated notice names both commands, in the order that works", async () => {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: (
            await suDb.inbox.findFirstOrThrow({
              where: { tenantId, chatwootInboxId: INBOX_ID },
              select: { id: true },
            })
          ).id,
          chatwootConversationId: 43,
          contactInboxId: 303,
          status: "open",
          threadId: `${tenantId}:${instanceId}:43`,
          // Never activated: this is the state the notice speaks in.
          testActivatedAt: null,
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      // A /reset typed here: it cannot run (no testActivatedAt) and falls through to the notice,
      // which is exactly the path whose wording this asserts.
      await sendReset("/reset", 43, { status: "open", assigneeType: "User" });

      const notes = cw.calls
        .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(notes).toContain("/teste");
      expect(notes).toContain("/reset");
      // The order matters: /reset before /teste is the no-op the reviewer caught.
      expect(notes.indexOf("/teste")).toBeLessThan(notes.indexOf("/reset"));
      await suDb.conversation.deleteMany({
        where: { tenantId, chatwootConversationId: 43 },
      });
    });

    test("a partial reset is not announced as a full one", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      const text = String(
        (acks[0]?.body as { content?: unknown } | null)?.content ?? "",
      );
      expect(text).not.toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
      expect(text).toMatch(/atributos/i);
    });

    // The test-mode gate's private note carries a one-shot watermark, and the note is the only thing
    // that tells whoever watches the inbox WHY the bot is silent and how to activate it. A note the
    // API refused was never delivered, so stamping it would spend that one shot on nothing.
    test("a test-mode notice the API refused does not spend its one shot", async () => {
      const convId = 43;
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { id: true },
      });
      const row = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          chatwootConversationId: convId,
          contactInboxId: 302,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${convId}`,
        },
        select: { id: true },
      });

      const failing = fakeChatwoot(/\/messages$/);
      globalThis.fetch = failing.impl;
      await sendReset("oi, tem alguém?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).toBeNull();

      // Still owed: the next message delivers it, and only then is the shot spent.
      const healthy = fakeChatwoot();
      globalThis.fetch = healthy.impl;
      await sendReset("alguém aí?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).not.toBeNull();
      expect(
        healthy.calls.filter(
          (c) => c.method === "POST" && c.path.endsWith("/messages"),
        ),
      ).toHaveLength(1);
    });

    test("a clean reset still announces the full success", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
    });
  },
);
