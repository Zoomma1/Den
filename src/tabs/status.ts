export type SessionStatus = "running" | "needs_input" | "done" | "error";

export const STATUSES: readonly SessionStatus[] = ["running", "needs_input", "done", "error"];

export const STATUS_META: Record<SessionStatus, { label: string; token: string }> = {
  running: { label: "Running", token: "--den-status-running" },
  needs_input: { label: "Needs input", token: "--den-status-needs-input" },
  done: { label: "Done", token: "--den-status-done" },
  error: { label: "Error", token: "--den-status-error-state" },
};
