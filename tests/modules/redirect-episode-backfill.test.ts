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
// identity column did not exist. It counts the contact's conversations OFF the widget's own inbox
// and answers only where there is one — never by reading a redirect anchor, and never by ordering
// them. Anchors are resettable by design (/reset clears them so the funnel can be tested again)
// while the token one described stays live for 24h, so an anchor that is gone proves nothing and a
// count over anchors can read as certainty while two links are still out there.
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

  test("it pairs a widget only where a single conversation proves the entry", async () => {
    const now = Date.now();
    // The ordinary shape: one entry conversation, which redirected.
    const plain = await episode(
      [{ sentAt: new Date(now - 120_000) }],
      new Date(now - 119_000),
    );
    // The same shape after a /reset wiped the anchor. The chat was linked, so a token WAS consumed,
    // and there is only one conversation it could have been minted on — the missing anchor says
    // nothing about that.
    const cleared = await episode([{ sentAt: null }], new Date(now - 119_000));
    // And the shape a count over anchors gets exactly wrong: /reset cleared the first conversation's
    // anchor without revoking its still-live link, then a SECOND entry conversation redirected.
    // Counting anchors sees one candidate and names the second one, permanently. Counting rows sees
    // two and declines.
    const afterReset = await episode(
      [{ sentAt: null }, { sentAt: new Date(now - 30_000) }],
      new Date(now - 20_000),
    );
    // Nothing off the widget inbox at all: nothing to pair.
    const lonely = await episode([], new Date(now));

    await suDb.$executeRawUnsafe(BACKFILL);

    expect(await identityOf(plain.widget)).toBe(plain.entryIds[0] as number);
    expect(await identityOf(cleared.widget)).toBe(
      cleared.entryIds[0] as number,
    );
    expect(await identityOf(afterReset.widget)).toBeNull();
    expect(await identityOf(lonely.widget)).toBeNull();
  });
});
