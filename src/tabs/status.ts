import type { TabLifecycleState } from "./lifecycle";

export type SessionStatus = "running" | "needs_input" | "done" | "error";

export const STATUSES: readonly SessionStatus[] = ["running", "needs_input", "done", "error"];

export const STATUS_META: Record<SessionStatus, { label: string; token: string }> = {
  running: { label: "Running", token: "--den-status-running" },
  needs_input: { label: "Needs input", token: "--den-status-needs-input" },
  done: { label: "Done", token: "--den-status-done" },
  error: { label: "Error", token: "--den-status-error-state" },
};

/** `failed` = échec hors lifecycle (invoke raté, cf. `markTabError`) ; `unseenDone` = tour fini pas encore consulté. */
export function sessionStatus(
  state: TabLifecycleState,
  flags: { unseenDone: boolean; failed: boolean },
): SessionStatus | null {
  if (state === "error" || flags.failed) return "error";
  if (state === "waiting") return "needs_input";
  if (state === "running") return "running";
  if (state === "idle" && flags.unseenDone) return "done";
  return null;
}

const ROLLUP_PRIORITY: readonly SessionStatus[] = ["needs_input", "error", "done", "running"];

export function rollupStatus(statuses: Iterable<SessionStatus | null>): SessionStatus | null {
  const present = new Set(statuses);
  return ROLLUP_PRIORITY.find((s) => present.has(s)) ?? null;
}
