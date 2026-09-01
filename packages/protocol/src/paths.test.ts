import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskDir, taskTmpDir, PathTraversalError, assertSafeIdSegment } from './paths.js';

test('taskDir builds a path nested under <workspace>/.redpen/tasks/<id>', () => {
  const dir = taskDir('/workspace', 'rpt_01J000000000000000000000');
  assert.match(dir, /\.redpen[\\/]tasks[\\/]rpt_01J000000000000000000000$/);
});

test('taskDir rejects an id containing ".." (path traversal)', () => {
  assert.throws(() => taskDir('/workspace', '../../etc/passwd'), PathTraversalError);
});

test('taskDir rejects an id containing a path separator', () => {
  assert.throws(() => taskDir('/workspace', 'rpt_foo/../../bar'), PathTraversalError);
  assert.throws(() => taskDir('/workspace', 'rpt_foo\\..\\bar'), PathTraversalError);
});

test('taskTmpDir rejects the same traversal attempts', () => {
  assert.throws(() => taskTmpDir('/workspace', '../evil'), PathTraversalError);
});

test('assertSafeIdSegment accepts a well-formed ULID-based id', () => {
  assert.doesNotThrow(() => assertSafeIdSegment('rpt_01J000000000000000000000'));
});

test('assertSafeIdSegment rejects empty string and null byte', () => {
  assert.throws(() => assertSafeIdSegment(''), PathTraversalError);
  assert.throws(() => assertSafeIdSegment('rpt_foo\0bar'), PathTraversalError);
});
