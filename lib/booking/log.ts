// Structured lifecycle log. Every code the PLAN names is emitted here and
// nowhere else, so the suite can assert both presence (`create_fenced` on a
// fenced replay) and **absence** — AC-11 requires the defensive
// `notify_no_pair` never to fire on any committed row (REV15-01).

export type LifecycleLogCode =
  | 'outcome_unresolved'
  | 'operation_superseded'
  | 'stale_finalize_ignored'
  | 'attempt_unresolved'
  | 'event_reaped'
  | 'version_bumped'
  | 'submission_discarded'
  | 'create_fenced'
  | 'stale_response_ignored'
  | 'notify_no_pair'
  | 'create_identity_mismatch'
  | 'unfinished_create_orphan'
  | 'gmail_send_failed'
  | 'calendar_insert_failed';

export type LifecycleLogEntry = {
  code: LifecycleLogCode;
  fields: Record<string, unknown>;
};

const entries: LifecycleLogEntry[] = [];
let echo = false;

export function logLifecycle(
  code: LifecycleLogCode,
  fields: Record<string, unknown> = {},
): void {
  entries.push({ code, fields });
  if (echo) {
    console.log(`${code} ${JSON.stringify(fields)}`);
  }
}

export function lifecycleLog(): LifecycleLogEntry[] {
  return entries.map((entry) => ({ code: entry.code, fields: { ...entry.fields } }));
}

export function lifecycleLogCount(code: LifecycleLogCode): number {
  return entries.filter((entry) => entry.code === code).length;
}

export function resetLifecycleLog(): void {
  entries.length = 0;
}

export function setLifecycleLogEcho(value: boolean): void {
  echo = value;
}
