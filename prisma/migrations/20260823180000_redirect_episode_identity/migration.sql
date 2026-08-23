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
-- The rule is the one the timestamps encode when they are read in the right order: the entry
-- conversation whose redirect was sent LAST at or before this widget was linked. That is the
-- generation the widget actually opened from, and it is a different question from "the entry
-- conversation that has been active most recently", which is what the code being replaced asked.
--
-- With one correction the column itself forces: `redirect_sent_at` is OVERWRITTEN by a resend (the
-- gate stamps the delivery, it does not append), so an entry conversation that redirected again
-- after its chat was linked now carries a timestamp AFTER the link and the rule above cannot see it.
-- The fallback covers that, and only where it cannot be wrong: when the contact has exactly ONE
-- conversation that ever redirected on this instance, that conversation is the entry whatever its
-- timestamp says. With several, the answer is genuinely unknown from the row alone and the column
-- stays null — which is the fail-closed direction (a funnel stage that does not fire) rather than
-- the open one (a goodbye and a RESOLVE landing on somebody else's conversation).
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
  (
    SELECT c."chatwoot_conversation_id"
    FROM "conversations" c
    WHERE c."tenant_id" = w."tenant_id"
      AND c."chatwoot_instance_id" = w."chatwoot_instance_id"
      AND c."contact_id" = w."contact_id"
      AND c."id" <> w."id"
      AND c."redirect_sent_at" IS NOT NULL
      AND c."redirect_sent_at" <= w."redirect_linked_at"
    ORDER BY c."redirect_sent_at" DESC
    LIMIT 1
  ),
  -- The resend case. HAVING with no GROUP BY yields one row when the condition holds and none when
  -- it does not, so this returns the id only where a single candidate exists.
  (
    SELECT MAX(c."chatwoot_conversation_id")
    FROM "conversations" c
    WHERE c."tenant_id" = w."tenant_id"
      AND c."chatwoot_instance_id" = w."chatwoot_instance_id"
      AND c."contact_id" = w."contact_id"
      AND c."id" <> w."id"
      AND c."redirect_sent_at" IS NOT NULL
    HAVING COUNT(*) = 1
  )
)
WHERE w."redirect_linked_at" IS NOT NULL
  AND w."contact_id" IS NOT NULL;

RESET app.is_super_admin;
