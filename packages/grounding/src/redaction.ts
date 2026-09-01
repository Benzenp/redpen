/**
 * Redaction assertions (docs/ARCHITECTURE.md §9, docs/IMPLEMENTATION_PLAN.md
 * Phase 3 완료 조건: "task bundle에 금지된 input value, cookie, storage data가
 * 없다"). Used both by tests and, defensively, before a bundle is written.
 */

export class ForbiddenDataError extends Error {
  constructor(public readonly needle: string) {
    super(`forbidden value found in serialized data: ${needle}`);
    this.name = 'ForbiddenDataError';
  }
}

/** Throws if any of `forbiddenValues` appears anywhere in the JSON-serialized `data`. */
export function assertNoForbiddenValues(data: unknown, forbiddenValues: readonly string[]): void {
  const serialized = JSON.stringify(data);
  for (const value of forbiddenValues) {
    if (value && serialized.includes(value)) {
      throw new ForbiddenDataError(value);
    }
  }
}
