/**
 * Daemon process entrypoint (docs/IMPLEMENTATION_PLAN.md Phase 4 "daemon
 * start|stop|status", "stale PID/port/token recovery").
 *
 * Run standalone via `redpen daemon start --foreground`, or spawned
 * detached by `ensureDaemonRunning()` (client/ensure-daemon.ts) when a CLI
 * command needs a daemon that isn't there yet.
 */
import { startDaemon } from './server.js';
import { writeDaemonDiscovery, clearDaemonDiscovery } from './discovery.js';

async function main() {
  const daemon = await startDaemon(0);
  await writeDaemonDiscovery({
    pid: process.pid,
    port: daemon.port,
    token: daemon.token,
    startedAt: new Date().toISOString(),
  });

  // Signal readiness on stdout for a parent process (ensure-daemon.ts) that
  // spawned this as a detached child and is waiting for the daemon to be up.
  console.log(JSON.stringify({ ready: true, port: daemon.port, pid: process.pid }));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await daemon.close();
    await clearDaemonDiscovery();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  daemon.server.once('redpenShutdownRequested', () => void shutdown());
}

main().catch((err) => {
  console.error('daemon failed to start:', err);
  process.exit(1);
});
