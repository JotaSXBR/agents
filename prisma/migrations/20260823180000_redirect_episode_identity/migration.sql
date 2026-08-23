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
-- The rule is PROVABILITY, and exactly one shape proves anything: a contact whose only conversation
-- outside this widget's own inbox is a single row. Every redirect token is minted on a conversation
-- of that contact somewhere off the widget inbox, so with one such row there is nothing else the
-- chat could have opened from.
--
-- It counts ROWS and not redirect anchors, which is the difference between a proof and a reading.
-- Every anchor this feature writes is resettable on purpose — /reset clears `redirect_sent_at` and
-- zeroes `redirect_count` so the funnel can be tested twice — while the token the cleared anchor
-- described stays live for its full 24h. A count over anchors can therefore fall to one while two
-- links are still out there. It does not use the ordering either: a link is single-use with a fixed
-- 24h TTL (docs/channel-redirect.md), so more than one can be live and the latest send is the one we
-- minted last, not the one that was clicked. Everything with two candidates stays null.
--
-- The inbox is read off the widget row rather than from config, because a migration does not have
-- the agent's: `inbox_id <> w.inbox_id` reaches the entry inbox and every other one the contact ever
-- wrote on, so a contact who also has an email conversation simply comes out unpaired. Fail-closed
-- in the direction that costs a funnel stage rather than a goodbye and a RESOLVE on somebody else's
-- conversation. Same tenant and same Chatwoot instance, which is the whole reach one episode has.
--
-- A correlated subquery in SET, not a LATERAL join: the UPDATE target is not a FROM item, so
-- Postgres refuses to let a LATERAL reference it (42P10). HAVING with no GROUP BY yields a row when
-- the condition holds and none when it does not, which is how one statement answers only where a
-- single candidate exists. The aggregate is there because HAVING needs one — over a single row MAX
-- and MIN are the same value, so it expresses no ordering.
UPDATE "conversations" w
SET "redirect_entry_conversation_id" = (
  SELECT MAX(c."chatwoot_conversation_id")
  FROM "conversations" c
  WHERE c."tenant_id" = w."tenant_id"
    AND c."chatwoot_instance_id" = w."chatwoot_instance_id"
    AND c."contact_id" = w."contact_id"
    AND c."inbox_id" <> w."inbox_id"
  HAVING COUNT(*) = 1
)
WHERE w."redirect_linked_at" IS NOT NULL
  AND w."contact_id" IS NOT NULL
  AND w."inbox_id" IS NOT NULL;

RESET app.is_super_admin;
