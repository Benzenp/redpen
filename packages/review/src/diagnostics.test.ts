import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticBundle } from './diagnostics.js';

test('buildDiagnosticBundle redacts keys matching the default sensitive-key list', () => {
  const bundle = buildDiagnosticBundle('rps_1', [
    {
      timestamp: '2026-09-01T00:00:00.000Z',
      level: 'error',
      message: 'login failed',
      context: { password: 'super-secret', username: 'alice' },
    },
  ]);
  assert.equal(bundle.entries[0].context?.password, '[REDACTED]');
  assert.equal(bundle.entries[0].context?.username, 'alice');
});

test('buildDiagnosticBundle redacts nested objects, not just top-level keys', () => {
  const bundle = buildDiagnosticBundle('rps_1', [
    {
      timestamp: '2026-09-01T00:00:00.000Z',
      level: 'info',
      message: 'request',
      context: { headers: { Authorization: 'Bearer xyz', 'Content-Type': 'application/json' } },
    },
  ]);
  const headers = bundle.entries[0].context?.headers as Record<string, unknown>;
  assert.equal(headers.Authorization, '[REDACTED]');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('buildDiagnosticBundle preserves entries with no context and carries sessionId/taskId', () => {
  const bundle = buildDiagnosticBundle('rps_1', [{ timestamp: '2026-09-01T00:00:00.000Z', level: 'info', message: 'ok' }], {
    taskId: 'rpt_1',
  });
  assert.equal(bundle.sessionId, 'rps_1');
  assert.equal(bundle.taskId, 'rpt_1');
  assert.equal(bundle.entries[0].context, undefined);
});

test('buildDiagnosticBundle accepts a custom redact key list', () => {
  const bundle = buildDiagnosticBundle(
    'rps_1',
    [{ timestamp: '2026-09-01T00:00:00.000Z', level: 'warn', message: 'x', context: { customSensitive: 'value', safe: 'ok' } }],
    { redactKeys: ['customSensitive'] },
  );
  assert.equal(bundle.entries[0].context?.customSensitive, '[REDACTED]');
  assert.equal(bundle.entries[0].context?.safe, 'ok');
});
