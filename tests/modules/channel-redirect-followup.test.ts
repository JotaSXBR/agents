import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  armRedirectChatFollowUp,
  chatFollowupNudge,
  minutesFromNow,
  parseRedirectFollowUpPayload,
  redirectFollowUpHandler,
  retireRedirectFollowUp,
} from "@/modules/channel-redirect/followup";
import { CHANNEL_REDIRECT_DEFAULTS } from "@/modules/channel-redirect/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

describe("parseRedirectFollowUpPayload", () => {
  test("valid chat-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  test("valid whatsapp-stage payload with a null entryInboxId", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "whatsapp",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toEqual({
      stage: "whatsapp",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: null,
    });
  });

  test("valid closing-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "closing",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "closing",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  test("rejects a missing/invalid stage", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "bogus",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({ widgetThreadId: "1:2:3", agentId: "9" }),
    ).toBeNull();
  });

  test("rejects a missing widgetThreadId or agentId", () => {
    expect(
      parseRedirectFollowUpPayload({ stage: "chat", agentId: "9" }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: 9, // wrong type (must be a string)
      }),
    ).toBeNull();
  });
});

describe("nudge builders", () => {
  test("chatFollowupNudge carries the redirect source + kind + instructions", () => {
    const n = chatFollowupNudge("Pergunte se ainda precisa de ajuda.");
    expect(n.source).toBe("channel-redirect");
    expect(n.kind).toBe("chat-followup");
    expect(n.instructions).toBe("Pergunte se ainda precisa de ajuda.");
  });
});

describe("minutesFromNow", () => {
  test("adds N minutes to the given instant", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    expect(minutesFromNow(60, now).toISOString()).toBe(
      "2026-07-05T13:00:00.000Z",
    );
    expect(minutesFromNow(0, now).toISOString()).toBe(now.toISOString());
  });
});

describe("armRedirectChatFollowUp", () => {
  function fakeEnqueue() {
    const calls: Array<Parameters<typeof enqueueJob>[0]> = [];
    const fn = (async (p: Parameters<typeof enqueueJob>[0]) => {
      calls.push(p);
      return 1n;
    }) as typeof enqueueJob;
    return { fn, calls };
  }

  const cfg = {
    ...CHANNEL_REDIRECT_DEFAULTS,
    chatFollowupEnabled: true,
    chatFollowupDelayValue: 30,
  };
  const now = new Date("2026-07-05T12:00:00Z");

  test("enqueues a REDIRECT_FOLLOWUP stage=chat job, dedupeKey by widgetThreadId, runAt = now + delay", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.kind).toBe("REDIRECT_FOLLOWUP");
    expect(call?.dedupeKey).toBe("redirect-followup:1:2:30");
    expect(call?.runAt.toISOString()).toBe("2026-07-05T12:30:00.000Z");
    expect(call?.payload).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:30",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  test("no-ops only when EVERY follow-up step is disabled", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: false,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("still arms (at stage chat) when the chat step is off but a later stage is on", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: true,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ stage: "chat" });
  });

  test("no-ops (defense in depth) when the thread's tenant/instance doesn't match — never enqueues across a tenant fence", async () => {
    const { fn, calls } = fakeEnqueue();
    const wrongTenant = await armRedirectChatFollowUp(
      {
        tenantId: 999n,
        instanceId: 2n,
        widgetThreadId: "1:2:30", // tenant 1, not 999
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    const wrongInstance = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 999n, // thread says instance 2
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    expect(wrongTenant).toBe(false);
    expect(wrongInstance).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ── The claimed-ladder fence, DB-backed. ──────────────────────────────────────────────────────────
//
// Cancelling reaches PENDING rows only, so a ladder the worker had already claimed runs to
// completion — and this ladder's terminal stage posts a closing on BOTH conversations and resolves
// them. `retireRedirectFollowUp` stamps every row of the key, claimed ones included; the handler is
// what reads the stamp.

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

describe.skipIf(!dbUp)("a ladder retired while claimed", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  let agentId = 0n;
  const WIDGET_CONV = 7171;
  let widgetThread = "";

  const stubClient = () => {
    const sent: Array<[number, string]> = [];
    const resolved: number[] = [];
    const client = {
      getConversation: async (c: number) => ({
        id: c,
        status: "pending",
        meta: {},
      }),
      sendMessage: async (c: number, t: string) => {
        sent.push([c, t]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      getConversationLabels: async () => [],
      setConversationLabels: async () => ({}),
      toggleStatus: async (c: number) => {
        resolved.push(c);
        return {};
      },
    } as unknown as ChatwootClient;
    return { sent, resolved, makeClient: async () => client };
  };

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LAD", slug: `lad-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    widgetThread = `${tenantId}:${instanceId}:${WIDGET_CONV}`;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          channelRedirect: {
            enabled: true,
            entryInboxId: 110,
            widgetInboxId: 111,
            chatFollowupEnabled: true,
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 11,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `lad-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 111,
        name: "Site",
        agentId: agent.id,
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: WIDGET_CONV,
        status: "pending",
        threadId: widgetThread,
        lastEventAt: new Date(),
        lastInboundAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  });

  const claimed = async (): Promise<ClaimedJob> => {
    const payload = {
      stage: "chat",
      widgetThreadId: widgetThread,
      agentId: agentId.toString(),
      entryInboxId: 110,
    };
    const row = await suDb.schedulerJob.upsert({
      where: {
        tenantId_kind_dedupeKey: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: `redirect-followup:${widgetThread}`,
        },
      },
      create: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: `redirect-followup:${widgetThread}`,
        status: "CLAIMED",
        runAt: new Date(),
        payload,
      },
      update: { status: "CLAIMED", payload },
    });
    // The snapshot the worker holds: captured at claim time, before any stamp.
    return {
      id: row.id,
      tenantId,
      kind: "REDIRECT_FOLLOWUP",
      payload,
      attempts: 0,
      claimSeq: 0,
    };
  };

  const deps = () => ({
    makeModel: () => new FakeListChatModel({ responses: ["Ainda por aí?"] }),
    checkpointer: new MemorySaver(),
    persistUsage: async () => {},
  });

  test("stands down instead of chasing the lead", async () => {
    const job = await claimed();
    await retireRedirectFollowUp(tenantId, widgetThread, appDb);
    const s = stubClient();

    const result = await redirectFollowUpHandler(job, appDb, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // Not just "no message": a retired ladder must not advance either, or the next stage — the one
    // that resolves BOTH conversations — is simply postponed.
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  test("an un-retired ladder still runs", async () => {
    const job = await claimed();
    const s = stubClient();

    await redirectFollowUpHandler(job, appDb, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // The control the negative above needs: a fence that stood every ladder down would pass it.
    expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV]);
  });
});
