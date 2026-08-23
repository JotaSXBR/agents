-- WHICH entry conversation a widget chat opened from, so "these two are one redirect episode" is an
-- identity instead of an inference.
--
-- What it replaces read the two anchors the funnel already writes and asked whether the widget was
-- linked at or after the entry sent its redirect. That is true of one episode's own pair, and it is
-- ALSO true of every later episode's widget — the ordering is one-sided, so it can only reject a
-- widget older than the entry, never a widget that belongs to a newer run. The two sides were then
-- each picked by activity, and `/reset` is itself activity: the command's own message advances
-- `last_event_at` on the conversation it is typed on (mirror runs before the gate), so a reset sent
-- on an OLD entry conversation makes that conversation the latest on its inbox while the widget side
-- is still the live episode's. The pair was accepted, and the command cleared the live widget's
-- anchors and tombstoned its ladder, its debounce and its appointment reminders.
ALTER TABLE "conversations"
  ADD COLUMN "redirect_entry_conversation_id" INTEGER;

-- `conversations` carries FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to the table OWNER
-- too. On managed Postgres the migration role is typically the owner WITHOUT rolsuper, and there
-- this backfill would match zero rows and report success (docs/deploy.md). Plain SET, not SET LOCAL:
-- outside a transaction SET LOCAL is a no-op with only a warning.
SET app.is_super_admin = 'on';

-- Backfilled, because leaving it null is not the safe direction here. The identity gates more than
-- /reset: `resolveWhatsAppSibling` is what the ladder's WhatsApp stage and its closing stage use to
-- find the conversation they message and resolve, so an upgrade that left every existing episode
-- unpaired would stop those two stages for funnels already in flight.
--
-- The rule is PROVABILITY, and only two shapes prove anything.
--
-- The first is a contact with exactly ONE conversation that ever redirected on this instance: that
-- conversation is the entry, whatever its timestamp says. It has to be read that way because
-- `redirect_sent_at` is OVERWRITTEN by a resend rather than appended to, so an entry that redirected
-- again after its chat was linked now carries a timestamp AFTER the link.
--
-- The second is several candidates NONE of which carries a post-link timestamp. Only then is "the
-- last redirect at or before the link" a proof rather than a guess: with a post-link timestamp
-- anywhere in the set, that conversation could be the true entry with its stamp moved, and the older
-- one the ordering would pick could be an unrelated earlier funnel. Both readings fit the rows
-- equally, and the rows are all a migration has.
--
-- Everything else stays null. That is the fail-closed direction — a funnel stage that does not fire
-- — and the alternative is a goodbye and a RESOLVE landing on somebody else's conversation, which is
-- the harm the identity column exists to prevent.
--
-- Only same tenant, same Chatwoot instance and same contact, which is the whole reach one episode
-- can have. It does NOT check the inbox pair, because a migration does not have the agent's config:
-- a tenant running two redirect funnels for one contact could be given the other funnel's entry.
-- That resolves itself at read time and in the safe direction — both callers look the stored id up
-- CONSTRAINED to the configured entry inbox, so an id from another pair matches no row and reads as
-- unpaired.
--
-- A correlated subquery in SET, not a LATERAL join: the UPDATE target is not a FROM item, so
-- Postgres refuses to let a LATERAL reference it (42P10).
UPDATE "conversations" w
SET "redirect_entry_conversation_id" = COALESCE(
  -- One candidate. HAVING with no GROUP BY yields a row when the condition holds and none when it
  -- does not, so this answers only where a single candidate exists.
  (
    SELECT MAX(c."chatwoot_conversation_id")
    FROM "conversations" c
    WHERE c."tenant_id" = w."tenant_id"
      AND c."chatwoot_instance_id" = w."chatwoot_instance_id"
      AND c."contact_id" = w."contact_id"
      AND c."id" <> w."id"
      AND c."redirect_sent_at" IS NOT NULL
    HAVING COUNT(*) = 1
  ),
  -- Several candidates, and none of them redirected after this chat was linked, so no timestamp in
  -- the set can have moved past it and the ordering is sound.
  (
    SELECT c."chatwoot_conversation_id"
    FROM "conversations" c
    WHERE c."tenant_id" = w."tenant_id"
      AND c."chatwoot_instance_id" = w."chatwoot_instance_id"
      AND c."contact_id" = w."contact_id"
      AND c."id" <> w."id"
      AND c."redirect_sent_at" IS NOT NULL
      AND c."redirect_sent_at" <= w."redirect_linked_at"
      AND NOT EXISTS (
        SELECT 1
        FROM "conversations" x
        WHERE x."tenant_id" = w."tenant_id"
          AND x."chatwoot_instance_id" = w."chatwoot_instance_id"
          AND x."contact_id" = w."contact_id"
          AND x."id" <> w."id"
          AND x."redirect_sent_at" > w."redirect_linked_at"
      )
    ORDER BY c."redirect_sent_at" DESC
    LIMIT 1
  )
)
WHERE w."redirect_linked_at" IS NOT NULL
  AND w."contact_id" IS NOT NULL;

RESET app.is_super_admin;
