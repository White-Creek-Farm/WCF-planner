-- ============================================================================
-- Migration 054: Cattle processing batches — add 'scheduled' status
-- ============================================================================
-- Adds 'scheduled' to the cattle_processing_batches.status CHECK so the
-- Cattle Batches workflow can persist a processor-date booking without
-- moving cattle to processed. Pairs with the new Scheduled section in
-- CattleBatchesView and the promote-or-create path in
-- CattleSendToProcessorModal.
--
-- Workflow this enables:
--   Planned   — virtual forecast only (no DB row).
--   Scheduled — real DB row with status='scheduled', planned_process_date
--               set, cows_detail '[]', cattle.herd and
--               cattle.processing_batch_id NEVER updated (cattle remain
--               forecast-eligible and dynamic).
--   Active    — DB row status='active', cows_detail attached from actual
--               sent weigh-in entries, cattle.herd='processed' for ONLY
--               the sent animals. Send-to-Processor promotes a matching
--               scheduled row OR inserts a fresh active row.
--   Processed — DB row status='complete'. UI label is "Processed" but the
--               DB value stays 'complete' to keep the existing RPC + JS
--               status comparisons stable.
--
-- Migration 043 previously locked status to ('active','complete'). This
-- migration replaces that CHECK with ('active','complete','scheduled').
-- Defaults, RLS, columns, and indexes are unchanged.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + re-ADD with the new shape.
-- Safe to re-apply.
-- ============================================================================

BEGIN;

ALTER TABLE cattle_processing_batches
  DROP CONSTRAINT IF EXISTS cattle_processing_batches_status_check;

ALTER TABLE cattle_processing_batches
  ADD CONSTRAINT cattle_processing_batches_status_check
  CHECK (status IN ('active', 'complete', 'scheduled'));

COMMIT;
