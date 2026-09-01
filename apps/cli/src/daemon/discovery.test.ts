import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonDiscoveryFilePath, globalAppDataDir } from '@redpen/protocol/paths';
import { readDaemonDiscovery, writeDaemonDiscovery, type DaemonDiscovery } from './discovery.js';

const first: DaemonDiscovery = {
  pid: 1234,
  port: 4312,
  token: 'test-token',
  startedAt: '2026-09-01T12:00:00.000Z',
};

async function withTemporaryAppData(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'redpen-discovery-test-'));
  const appData = process.env.APPDATA;
  const xdgDataHome = process.env.XDG_DATA_HOME;
  process.env.APPDATA = directory;
  process.env.XDG_DATA_HOME = directory;
  try {
    await run();
  } finally {
    if (appData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = appData;
    if (xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdgDataHome;
    await rm(directory, { recursive: true, force: true });
  }
}

test('daemon discovery persists only valid, private records', async (t) => {
  await withTemporaryAppData(async () => {
    await t.test('round-trips a valid record', async () => {
      await writeDaemonDiscovery(first);
      assert.deepEqual(await readDaemonDiscovery(), first);
    });

    await t.test('quarantines malformed and truncated records', async () => {
      await writeFile(daemonDiscoveryFilePath(), '{"pid":');
      assert.equal(await readDaemonDiscovery(), null);
      await assert.rejects(readFile(daemonDiscoveryFilePath()));
    });

    await t.test('quarantines records with invalid bounds and fields', async () => {
      const invalid = [
        { ...first, pid: 0 },
        { ...first, pid: 1.5 },
        { ...first, port: 65_536 },
        { ...first, token: '   ' },
        { ...first, startedAt: 'not-a-date' },
      ];

      for (const record of invalid) {
        await writeFile(daemonDiscoveryFilePath(), JSON.stringify(record));
        assert.equal(await readDaemonDiscovery(), null);
        await assert.rejects(readFile(daemonDiscoveryFilePath()));
      }
      await assert.rejects(writeDaemonDiscovery({ ...first, port: 0 }));
    });

    await t.test('atomically replaces the current record without temporary leftovers', async () => {
      await writeDaemonDiscovery(first);
      const replacement = { ...first, pid: 5678, port: 9876, token: 'replacement-token' };
      await writeDaemonDiscovery(replacement);

      assert.deepEqual(await readDaemonDiscovery(), replacement);
      assert.deepEqual((await readdir(globalAppDataDir())).filter((name) => name.endsWith('.tmp')), []);
    });

    await t.test('uses requested POSIX owner-only modes', { skip: process.platform === 'win32' }, async () => {
      await writeDaemonDiscovery(first);
      assert.equal((await stat(globalAppDataDir())).mode & 0o777, 0o700);
      assert.equal((await stat(daemonDiscoveryFilePath())).mode & 0o777, 0o600);
    });

    await t.test('does not follow discovery symlinks', { skip: process.platform === 'win32' }, async () => {
      const victim = join(globalAppDataDir(), 'victim.json');
      await writeDaemonDiscovery(first);
      await writeFile(victim, 'do not replace');
      await rm(daemonDiscoveryFilePath());
      await symlink(victim, daemonDiscoveryFilePath());

      assert.equal(await readDaemonDiscovery(), null);
      assert.equal(await readFile(victim, 'utf8'), 'do not replace');

      await symlink(victim, daemonDiscoveryFilePath());
      await writeDaemonDiscovery({ ...first, token: 'new-token' });
      assert.equal(await readFile(victim, 'utf8'), 'do not replace');
      assert.deepEqual(await readDaemonDiscovery(), { ...first, token: 'new-token' });
    });
  });
});
