import assert from 'node:assert/strict';
import test from 'node:test';
import { UnsupportedUrlError, assertLoopbackUrl } from './url-policy.js';

test('accepts HTTP(S) loopback URLs', () => {
  assert.equal(assertLoopbackUrl('http://localhost:5173/path').href, 'http://localhost:5173/path');
  assert.equal(assertLoopbackUrl('https://127.0.0.1/').href, 'https://127.0.0.1/');
  assert.equal(assertLoopbackUrl('http://[::1]:3000/').href, 'http://[::1]:3000/');
});

test('rejects non-HTTP protocols and credentials', () => {
  for (const url of [
    'ftp://localhost/file',
    'ws://127.0.0.1/socket',
    'http://user:secret@localhost/',
  ]) {
    assert.throws(() => assertLoopbackUrl(url), UnsupportedUrlError);
  }
});

test('rejects non-loopback hosts and malformed URLs', () => {
  assert.throws(() => assertLoopbackUrl('http://example.com/'), UnsupportedUrlError);
  assert.throws(() => assertLoopbackUrl('not a url'), UnsupportedUrlError);
});
