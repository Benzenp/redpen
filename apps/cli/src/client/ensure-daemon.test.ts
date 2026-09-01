import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import type { DaemonDiscovery } from '../daemon/discovery.js';

const discovery: DaemonDiscovery = {
  pid: 4321,
  port: 4312,
  token: 'test-token',
  startedAt: '2026-09-01T12:00:00.000Z',
};

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {}
}

async function withTemporaryAppData(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'redpen-ensure-daemon-test-'));
  const appData = process.env.APPDATA;
  const xdgDataHome = process.env.XDG_DATA_HOME;
  process.env.APPDATA = directory;
  process.env.XDG_DATA_HOME = directory;
  try {
    await run();
  } finally {
    mock.reset();
    if (appData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = appData;
    if (xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdgDataHome;
    await rm(directory, { recursive: true, force: true });
  }
}

async function loadEnsureDaemon(options: {
  read: () => Promise<DaemonDiscovery | null>;
  health: () => Promise<'running' | 'stale-pid' | 'hung' | 'not-running'>;
  alive?: (pid: number) => boolean;
  clear?: () => Promise<void>;
  spawn: () => FakeChild;
}) {
  mock.module('../daemon/discovery.js', {
    namedExports: {
      readDaemonDiscovery: options.read,
      probeDaemonHealth: options.health,
      isProcessAlive: options.alive ?? (() => true),
      clearDaemonDiscovery: options.clear ?? (async () => {}),
    },
  });
  mock.module('node:child_process', { namedExports: { spawn: options.spawn } });
  return import(`./ensure-daemon.js?test=${Math.random()}`);
}

test('ensureDaemonRunning serializes startup and accepts readiness after log lines', { concurrency: false }, async () => {
  await withTemporaryAppData(async () => {
    let current: DaemonDiscovery | null = null;
    let spawns = 0;
    const { ensureDaemonRunning } = await loadEnsureDaemon({
      read: async () => current,
      health: async () => (current ? 'running' : 'not-running'),
      spawn: () => {
        spawns += 1;
        const child = new FakeChild();
        queueMicrotask(() => {
          current = discovery;
          child.stdout.write('starting daemon\n');
          child.stdout.write(`${JSON.stringify({ ready: true })}\n`);
        });
        return child;
      },
    });

    const [first, second] = await Promise.all([ensureDaemonRunning(), ensureDaemonRunning()]);
    assert.deepEqual(first, discovery);
    assert.deepEqual(second, discovery);
    assert.equal(spawns, 1);
  });
});

test('ensureDaemonRunning rejects when the child exits before readiness', { concurrency: false }, async () => {
  await withTemporaryAppData(async () => {
    const { ensureDaemonRunning } = await loadEnsureDaemon({
      read: async () => null,
      health: async () => 'not-running',
      spawn: () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stderr.write('startup failed');
          child.emit('exit', 1, null);
        });
        return child;
      },
    });

    await assert.rejects(ensureDaemonRunning(), /exited before readiness.*startup failed/);
  });
});

test('ensureDaemonRunning settles a discovery-read failure after readiness', { concurrency: false }, async () => {
  await withTemporaryAppData(async () => {
    let reads = 0;
    const { ensureDaemonRunning } = await loadEnsureDaemon({
      read: async () => {
        reads += 1;
        if (reads > 3) throw new Error('discovery unavailable');
        return null;
      },
      health: async () => 'not-running',
      spawn: () => {
        const child = new FakeChild();
        queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
        return child;
      },
    });

    await assert.rejects(ensureDaemonRunning(), /discovery unavailable/);
  });
});

test('ensureDaemonRunning clears stale records without signaling an unverified live PID', { concurrency: false }, async () => {
  await withTemporaryAppData(async () => {
    let current: DaemonDiscovery | null = discovery;
    let cleared = false;
    let spawns = 0;
    const { ensureDaemonRunning } = await loadEnsureDaemon({
      read: async () => current,
      health: async () => (current?.pid === 4322 ? 'running' : current ? 'stale-pid' : 'not-running'),
      alive: () => false,
      clear: async () => {
        cleared = true;
        current = null;
      },
      spawn: () => {
        spawns += 1;
        const child = new FakeChild();
        queueMicrotask(() => {
          current = { ...discovery, pid: 4322 };
          child.stdout.write('{"ready":true}\n');
        });
        return child;
      },
    });
    await ensureDaemonRunning();
    assert.equal(spawns, 1);
    assert.equal(cleared, true);

    mock.reset();
    let liveCurrent: DaemonDiscovery | null = discovery;
    let liveCleared = false;
    const live = await loadEnsureDaemon({
      read: async () => liveCurrent,
      health: async () => (liveCurrent?.pid === 4322 ? 'running' : liveCurrent ? 'hung' : 'not-running'),
      alive: () => true,
      clear: async () => {
        liveCleared = true;
        liveCurrent = null;
      },
      spawn: () => {
        spawns += 1;
        const child = new FakeChild();
        queueMicrotask(() => {
          liveCurrent = { ...discovery, pid: 4322 };
          child.stdout.write('{"ready":true}\n');
        });
        return child;
      },
    });
    assert.equal((await live.ensureDaemonRunning()).pid, 4322);
    assert.equal(spawns, 2);
    assert.equal(liveCleared, true);
  });
});

test('ensureDaemonRunning gives a temporarily unresponsive daemon a recovery grace period', { concurrency: false }, async () => {
  await withTemporaryAppData(async () => {
    let healthChecks = 0;
    let spawns = 0;
    let clears = 0;
    const loaded = await loadEnsureDaemon({
      read: async () => discovery,
      health: async () => (++healthChecks >= 4 ? 'running' : 'hung'),
      alive: () => true,
      clear: async () => { clears += 1; },
      spawn: () => {
        spawns += 1;
        return new FakeChild();
      },
    });

    assert.equal((await loaded.ensureDaemonRunning()).pid, discovery.pid);
    assert.equal(spawns, 0);
    assert.equal(clears, 0);
  });
});
