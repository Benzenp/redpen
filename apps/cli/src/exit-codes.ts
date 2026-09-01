/** Stable exit code table (docs/IMPLEMENTATION_PLAN.md Phase 4 "stable exit code 표"). */
export const EXIT_CODES = {
  OK: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  NOT_FOUND: 3,
  INVALID_STATE: 4,
  DAEMON_UNAVAILABLE: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
