/**
 * Storage maintenance for operators: a database↔files consistency check and a
 * sweep (orphans, abandoned render directories, retention of old versions).
 * Used by scripts/data-maintenance.ts; never by the pipeline itself.
 */
export { checkData, type CheckReport, type DataIssue, type DataIssueCode } from './check.js';
export { sweepData, type SweepAction, type SweepActionKind, type SweepOptions, type SweepReport } from './sweep.js';
export { listDataDirs, type DataDir } from './scan.js';
