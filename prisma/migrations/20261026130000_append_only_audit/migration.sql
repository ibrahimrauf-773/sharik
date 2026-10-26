-- Audit log is append-only: block UPDATE/DELETE at the database level.
CREATE OR REPLACE FUNCTION sharik_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION sharik_block_mutation();

-- Ledger lines and journal entries are immutable too (corrections are new reversing entries).
CREATE TRIGGER ledger_line_append_only BEFORE UPDATE OR DELETE ON "LedgerLine"
  FOR EACH ROW EXECUTE FUNCTION sharik_block_mutation();
CREATE TRIGGER journal_entry_append_only BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION sharik_block_mutation();

-- Every journal entry must balance (checked at COMMIT time).
CREATE OR REPLACE FUNCTION sharik_check_entry_balanced() RETURNS trigger AS $$
DECLARE s BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountPaisa"),0) INTO s FROM "LedgerLine" WHERE "entryId" = NEW."entryId";
  IF s <> 0 THEN RAISE EXCEPTION 'journal entry % is unbalanced (%)', NEW."entryId", s; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT ON "LedgerLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sharik_check_entry_balanced();

-- Campaign can never be over-committed.
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_not_overfilled CHECK ("committedPaisa" >= 0 AND "committedPaisa" <= "targetPaisa");
