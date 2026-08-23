import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { seedChatwootInstance } from "../utils/chatwoot";

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

// The statement is READ FROM THE MIGRATION, not retyped here. A copy would go on passing after the
// file it stands for changed, which is the failure mode this rule is most exposed to: the backfill
// runs once per deployment and what it writes is permanent.
const MIGRATION_SQL = await Bun.file(
  new URL(
    "../../prisma/migrations/20260823180000_redirect_episode_identity/migration.sql",
    import.meta.url,
  ),
).text();
const BACKFILL = (() => {
  const start = MIGRATION_SQL.indexOf('UPDATE "conversations" w');
  const end = MIGRATION_SQL.indexOf(
    ";",
    MIGRATION_SQL.indexOf('w."contact_id" IS NOT NULL', start),
  );
  if (start < 0 || end < 0) throw new Error("backfill statement not found");
  return MIGRATION_SQL.slice(start, end + 1);
})();

let tenantId = 0n;
let instanceId = 0n;
let waInboxId = 0n;
let widgetInboxId = 0n;

// What the backfill has to decide, from rows alone, for funnels that were already running when the
// identity column did not exist. It answers with `redirect_sent_at`, and that column is OVERWRITTEN
// by a resend rather than appended to — so the reading has to survive an entry conversation whose
// timestamp moved past the link it produced.
describe.skipIf(!dbUp)("the redirect identity backfill", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "BF", slug: `bf-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 71,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    waInboxId = (
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 71,
          name: "WhatsApp",
          channelType: "Channel::Whatsapp",
        },
      })
    ).id;
    widgetInboxId = (
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 72,
          name: "Site",
          channelType: "Channel::WebWidget",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
  });

  let nextContact = 500;
  let nextConv = 6000;
  const episode = async (
    entries: Array<{ sentAt: Date | null }>,
    linkedAt: Date,
  ): Promise<{ widget: number; entryIds: number[] }> => {
    nextContact += 1;
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: nextContact,
      },
    });
    const entryIds: number[] = [];
    for (const e of entries) {
      nextConv += 1;
      const id = nextConv;
      entryIds.push(id);
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: waInboxId,
          contactId: contact.id,
          chatwootConversationId: id,
          status: "open",
          threadId: `${tenantId}:${instanceId}:${id}`,
          redirectSentAt: e.sentAt,
        },
      });
    }
    nextConv += 1;
    const widget = nextConv;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: widgetInboxId,
        contactId: contact.id,
        chatwootConversationId: widget,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${widget}`,
        redirectLinkedAt: linkedAt,
      },
    });
    return { widget, entryIds };
  };

  const identityOf = async (widget: number): Promise<number | null> => {
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: widget },
      select: { redirectEntryConversationId: true },
    });
    return row.redirectEntryConversationId;
  };

  test("it pairs each widget with the redirect it opened from", async () => {
    const now = Date.now();
    // The ordinary shape: one redirect, then the chat.
    const plain = await episode(
      [{ sentAt: new Date(now - 120_000) }],
      new Date(now - 119_000),
    );
    // The resend: the SAME entry conversation redirected again after the chat was linked, so its
    // timestamp now sits AFTER the link. Reading the order alone would lose it.
    const resent = await episode(
      [{ sentAt: new Date(now + 60_000) }],
      new Date(now - 119_000),
    );
    // Two funnels for one contact, and only one of them redirected before this chat was linked. The
    // ordering still answers, and the fallback must NOT override it.
    const ordered = await episode(
      [{ sentAt: new Date(now - 200_000) }, { sentAt: new Date(now + 60_000) }],
      new Date(now - 100_000),
    );
    // Two funnels, and BOTH timestamps sit after the link — each could have been resent. Which one
    // this chat opened from is not in the rows, so the answer is none: a funnel stage that does not
    // fire, rather than a goodbye and a RESOLVE landing on somebody else's conversation.
    const ambiguous = await episode(
      [{ sentAt: new Date(now + 30_000) }, { sentAt: new Date(now + 60_000) }],
      new Date(now - 100_000),
    );
    // A contact who never redirected: nothing to pair.
    const unrelated = await episode([{ sentAt: null }], new Date(now));

    await suDb.$executeRawUnsafe(BACKFILL);

    expect(await identityOf(plain.widget)).toBe(plain.entryIds[0] as number);
    expect(await identityOf(resent.widget)).toBe(resent.entryIds[0] as number);
    expect(await identityOf(ordered.widget)).toBe(
      ordered.entryIds[0] as number,
    );
    expect(await identityOf(ambiguous.widget)).toBeNull();
    expect(await identityOf(unrelated.widget)).toBeNull();
  });
});
