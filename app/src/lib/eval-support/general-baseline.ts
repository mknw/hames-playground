/**
 * The removed `general` agent's last live results on the baseline scenarios.
 *
 * The flip gate (#606) asks for "no regression on `general`'s current cases".
 * That used to be measured by running `general` beside the candidate in the same
 * eval. The agent was removed on 2026-10-21, so the comparison is now against
 * this FROZEN record, not a re-run: it can be satisfied or failed by the
 * candidate's rows, but it can no longer be re-measured on `general`'s side.
 *
 * Each entry is the agent's result in its most recent live private-tier run of
 * that scenario (#507 comments; commit and run named per entry). Only `pass`
 * entries bar the candidate — a baseline that failed imposes no bar, exactly as
 * the old rule counted only a baseline that passed in the run at hand.
 *
 * `07-follow-up-success` is the unstable one: it failed in three live runs and
 * passed in one (the 2026-10-19 night pass). The latest observation is `fail`,
 * so it bars nothing; if the owner reads the single pass as the real baseline,
 * change the entry — the gate and its pin follow.
 */
export type BaselineStatus = 'pass' | 'fail'

export const GENERAL_BASELINE: Readonly<Record<string, BaselineStatus>> = {
  // Eval run 3, 2026-10-20 (main 664c464a): #507 comment 6281039851.
  '01-greeting': 'pass',
  '02-graph-count': 'pass',
  '03-web-read': 'pass',
  // Eval run 2, 2026-10-19 (main b90eb2ba): #507 comment 6278332237. Not re-run since.
  '04-library-docs': 'pass',
  // CHANGED MEANING, 2026-10-22: this `pass` measured the shared-memory-graph lookup, which
  // is retired (PR #744). 05 is now a per-user memory recall, so the entry still bars the
  // candidate on 05 but has no live reading of the new behaviour: re-baselined at the next
  // live run. The gate still counts the same six passes (01-06).
  '05-memory-lookup': 'pass',
  // Eval run 5, 2026-10-20 (main 9ca83e9a): #507 comment 6292721566. Also passed in
  // run 3; failed in the first live run, before the Return-only fix (#612).
  '06-read-only': 'pass',
  // Eval run 3, 2026-10-20: failed ("can't double a number that wasn't provided").
  // Also failed in runs 1 and 2; passed once, in the 2026-10-19 night pass.
  '07-follow-up-success': 'fail',
}
