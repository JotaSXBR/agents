-- `send_quote` (issue #21) reads the thread's newest quote on the customer-facing path, so every
-- call filters `quotes` by thread. The table had only the tenant index, which leaves that lookup as
-- a scan of the tenant's whole quote history to find the two rows belonging to one conversation.
--
-- The ordering is deliberately not part of the index: one thread holds a handful of quotes, so
-- sorting what this narrows to is free, and a three-column index would be paid for on every write.
CREATE INDEX "quotes_tenant_id_thread_id_idx" ON "quotes"("tenant_id", "thread_id");
