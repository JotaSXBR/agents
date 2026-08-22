-- Bind the quotes that already exist to the conversation they were always for (issue #21).
--
-- `POST /v1/quotes` has always accepted a Chatwoot conversation id and never filled `thread_id`,
-- because nothing read it. `send_quote` reads it, and reads ONLY it — a Chatwoot conversation id is
-- unique per account, not per tenant, so it is not enough to hand a priced document to a customer
-- by. Without this, every quote generated before the upgrade is invisible to the tool: the agent
-- answers "there is no quote for this conversation" about conversations that have one.
--
-- Fail-closed, the same rule `resolveThreadId` applies at generation: bind only where the tenant has
-- EXACTLY ONE mirrored conversation carrying that number. A tenant running two Chatwoot accounts has
-- two conversations numbered alike, belonging to two different people, and neither is a safe guess.
-- The rule is written twice on purpose — a migration is a frozen artifact and must not follow a
-- later change of the rule; it has to keep doing what was correct on the day it ran.
--
-- `quotes` and `conversations` both carry FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to
-- the table OWNER as well and only a superuser is exempt. docs/deploy.md allows
-- MIGRATION_DATABASE_URL to be "superuser OR DB owner", and on managed Postgres the administrative
-- role is typically the owner WITHOUT rolsuper — there a bare UPDATE matches zero rows and reports
-- success, which is exactly how issue #106 lost an entire backfill in silence. Plain SET and not
-- SET LOCAL: outside a transaction SET LOCAL is a no-op with only a warning, which would reproduce
-- the failure this line exists to avoid.
SET app.is_super_admin = 'on';

-- Idempotent by construction: it only ever writes rows that have no binding, and the value is a pure
-- function of (tenant, conversation). Re-running it is a no-op, and a quote whose conversation was
-- never mirrored stays null — undeliverable, which is what it already was.
UPDATE "quotes" q
SET "thread_id" = c."thread_id"
FROM "conversations" c
WHERE q."thread_id" IS NULL
  AND q."conversation_id" IS NOT NULL
  AND c."tenant_id" = q."tenant_id"
  AND c."chatwoot_conversation_id" = q."conversation_id"
  AND NOT EXISTS (
    SELECT 1
      FROM "conversations" c2
     WHERE c2."tenant_id" = q."tenant_id"
       AND c2."chatwoot_conversation_id" = q."conversation_id"
       AND c2."id" <> c."id"
  );

RESET app.is_super_admin;
