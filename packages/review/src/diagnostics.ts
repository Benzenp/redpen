/**
 * Diagnostic bundle with debug log redaction (docs/IMPLEMENTATION_PLAN.md
 * Phase 6: "진단 bundle과 debug log redaction"; docs/ARCHITECTURE.md §9's
 * redaction principles applied to logs, not just DOM metadata).
 */

const DEFAULT_REDACT_KEYS = ['password', 'token', 'secret', 'cookie', 'authorization', 'apiKey', 'api_key'];

export interface DiagnosticEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface DiagnosticBundle {
  generatedAt: string;
  sessionId: string;
  taskId?: string;
  entries: DiagnosticEntry[];
}

function redactValue(key: string, value: unknown, redactKeys: string[]): unknown {
  const lowerKey = key.toLowerCase();
  if (redactKeys.some((rk) => lowerKey.includes(rk.toLowerCase()))) {
    return '[REDACTED]';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return redactObject(value as Record<string, unknown>, redactKeys);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>, redactKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = redactValue(key, value, redactKeys);
  }
  return out;
}

export function buildDiagnosticBundle(
  sessionId: string,
  entries: DiagnosticEntry[],
  options: { taskId?: string; redactKeys?: string[] } = {},
): DiagnosticBundle {
  const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  const redactedEntries = entries.map((entry) => ({
    ...entry,
    context: entry.context ? redactObject(entry.context, redactKeys) : undefined,
  }));
  return {
    generatedAt: new Date().toISOString(),
    sessionId,
    taskId: options.taskId,
    entries: redactedEntries,
  };
}
