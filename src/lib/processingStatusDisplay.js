// Shared display vocabulary for animal processing status.
// Stored/source values intentionally stay as-is (active, processed, scheduled,
// complete) while the UI speaks the WCF planner language.

export const PROCESSING_STATUS_DISPLAY = Object.freeze({
  planned: 'Planned',
  inProcess: 'In Process',
  complete: 'Complete',
});

const COMPLETE_VALUES = new Set(['complete', 'completed', 'processed', 'done']);
// 'in-proccess' / 'in proccess' are the REAL Asana "Status (Processing)" option
// spelling (double-c) on the SF Processing Calendar — normalize, don't correct
// the stored value.
const IN_PROCESS_VALUES = new Set([
  'active',
  'in_process',
  'in-process',
  'in process',
  'processing',
  'in-proccess',
  'in proccess',
  'in_proccess',
]);
const PLANNED_VALUES = new Set(['planned', 'scheduled', 'reserved', 'tbc', 'goal']);

export function normalizeProcessingStatus(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (COMPLETE_VALUES.has(raw)) return 'complete';
  if (IN_PROCESS_VALUES.has(raw)) return 'in_process';
  if (PLANNED_VALUES.has(raw)) return 'planned';
  return 'planned';
}

export function processingStatusLabel(value) {
  const status = normalizeProcessingStatus(value);
  if (status === 'complete') return PROCESSING_STATUS_DISPLAY.complete;
  if (status === 'in_process') return PROCESSING_STATUS_DISPLAY.inProcess;
  return PROCESSING_STATUS_DISPLAY.planned;
}

export function processingStatusVariantFromLabel(label) {
  if (label === PROCESSING_STATUS_DISPLAY.complete) return 'neutral';
  if (label === PROCESSING_STATUS_DISPLAY.inProcess) return 'ok';
  return 'warn';
}

function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function statusFromRecord(recordOrStatus) {
  return recordOrStatus && typeof recordOrStatus === 'object' ? recordOrStatus.status : recordOrStatus;
}

export function pigBatchProcessingStatusLabel(recordOrStatus, metrics = {}) {
  const status = normalizeProcessingStatus(statusFromRecord(recordOrStatus));
  if (status === 'complete') return PROCESSING_STATUS_DISPLAY.complete;
  if (status === 'planned') return PROCESSING_STATUS_DISPLAY.planned;
  if (positiveCount(metrics.started) || positiveCount(metrics.current)) return PROCESSING_STATUS_DISPLAY.inProcess;
  return PROCESSING_STATUS_DISPLAY.planned;
}

export function pigBatchProcessingStatusVariant(recordOrStatus, metrics = {}) {
  return processingStatusVariantFromLabel(pigBatchProcessingStatusLabel(recordOrStatus, metrics));
}
