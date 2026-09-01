/**
 * Schema migration entrypoint (docs/ARCHITECTURE.md §3.1).
 *
 * MVP ships only schemaVersion 1, so this module is currently a typed no-op
 * registry. Future versions register a migrator keyed by the *source*
 * version; `migrateToLatest` walks forward from whatever version is found on
 * disk until it reaches `SCHEMA_VERSION`.
 */
import { SCHEMA_VERSION } from './schema.js';

export type Migrator = (input: unknown) => unknown;

const migrators = new Map<number, Migrator>();

export class UnknownSchemaVersionError extends Error {
  constructor(public readonly version: number) {
    super(`no migration path registered from schemaVersion ${version}`);
    this.name = 'UnknownSchemaVersionError';
  }
}

export function registerMigration(fromVersion: number, migrator: Migrator): void {
  migrators.set(fromVersion, migrator);
}

export function migrateToLatest(input: { schemaVersion: number }): unknown {
  let current: { schemaVersion: number } = input;
  while (current.schemaVersion < SCHEMA_VERSION) {
    const migrator = migrators.get(current.schemaVersion);
    if (!migrator) {
      throw new UnknownSchemaVersionError(current.schemaVersion);
    }
    current = migrator(current) as { schemaVersion: number };
  }
  return current;
}
