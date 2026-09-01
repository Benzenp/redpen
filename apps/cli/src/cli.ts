/**
 * `redpen` CLI entrypoint (docs/ARCHITECTURE.md §3.3).
 *
 * JSON mode rules enforced here:
 * - stdout carries exactly one JSON document when `--json` is passed.
 * - progress/human text always goes to stderr.
 * - IDs and paths are never truncated.
 */
import { DaemonClient, DaemonRequestError } from './client/daemon-client.js';
import { EXIT_CODES } from './exit-codes.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function printHuman(text: string): void {
  process.stderr.write(text + '\n');
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const json = hasFlag(rest, '--json');
  const workspaceRoot = flagValue(rest, '--project') ?? process.cwd();

  try {
    switch (command) {
      case 'open': {
        const url = rest.find((a) => !a.startsWith('--') && a !== workspaceRoot);
        if (!url) {
          printHuman('usage: redpen open <url> [--project <path>] [--json]');
          return EXIT_CODES.USAGE_ERROR;
        }
        const client = await DaemonClient.connect();
        const { session } = await client.openSession(url, workspaceRoot);
        if (json) printJson({ session });
        else printHuman(`session ${(session as { id: string }).id} opened (state=${(session as { state: string }).state})`);
        return EXIT_CODES.OK;
      }

      case 'list': {
        const client = await DaemonClient.connect();
        const { sessions } = await client.listSessions(workspaceRoot);
        if (json) printJson({ sessions });
        else for (const s of sessions as { id: string; state: string }[]) printHuman(`${s.id}\t${s.state}`);
        return EXIT_CODES.OK;
      }

      case 'status': {
        const sessionId = rest[0];
        if (!sessionId) {
          printHuman('usage: redpen status <session-id> [--json]');
          return EXIT_CODES.USAGE_ERROR;
        }
        const client = await DaemonClient.connect();
        const { session } = await client.getSession(sessionId);
        if (json) printJson({ session });
        else printHuman(JSON.stringify(session, null, 2));
        return EXIT_CODES.OK;
      }

      case 'freeze': {
        const sessionId = rest[0];
        const client = await DaemonClient.connect();
        const { session } = await client.freeze(sessionId);
        if (json) printJson({ session });
        else printHuman(`session ${sessionId} frozen (state=${(session as { state: string }).state})`);
        return EXIT_CODES.OK;
      }

      case 'submit': {
        const sessionId = rest[0];
        const note = flagValue(rest, '--note');
        const client = await DaemonClient.connect();
        const result = await client.submit(sessionId, note);
        if (json) printJson(result);
        else printHuman(`submitted task ${result.taskId}`);
        return EXIT_CODES.OK;
      }

      case 'wait': {
        const sessionId = rest[0];
        const timeout = Number(flagValue(rest, '--timeout') ?? '600');
        const client = await DaemonClient.connect();
        const result = await client.wait(sessionId, timeout);
        if (json) printJson(result);
        else printHuman(result.taskId ? `task submitted: ${result.taskId}` : 'timed out; session still open');
        return EXIT_CODES.OK;
      }

      case 'claim': {
        const sessionId = rest[0];
        const client = await DaemonClient.connect();
        const { session } = await client.claim(sessionId);
        if (json) printJson({ session });
        else printHuman(`session ${sessionId} claimed (state=${(session as { state: string }).state})`);
        return EXIT_CODES.OK;
      }

      case 'review': {
        const sessionId = rest[0];
        const client = await DaemonClient.connect();
        const { session } = await client.reviewReady(sessionId);
        if (json) printJson({ session });
        else printHuman(`session ${sessionId} in review (state=${(session as { state: string }).state})`);
        return EXIT_CODES.OK;
      }

      case 'accept': {
        const sessionId = rest[0];
        const client = await DaemonClient.connect();
        const { session } = await client.accept(sessionId);
        if (json) printJson({ session });
        else printHuman(`session ${sessionId} accepted (state=${(session as { state: string }).state})`);
        return EXIT_CODES.OK;
      }

      case 'close': {
        const sessionId = rest[0];
        const client = await DaemonClient.connect();
        await client.closeSession(sessionId);
        if (json) printJson({ ok: true });
        else printHuman(`session ${sessionId} closed`);
        return EXIT_CODES.OK;
      }

      case 'task': {
        const taskId = rest[0];
        const client = await DaemonClient.connect();
        const { task } = await client.getTask(taskId, workspaceRoot);
        if (json) printJson({ task });
        else printHuman(JSON.stringify(task, null, 2));
        return EXIT_CODES.OK;
      }

      default:
        printHuman(
          'usage: redpen <open|list|status|freeze|submit|wait|claim|review|accept|close|task> [...] [--json] [--project <path>]',
        );
        return EXIT_CODES.USAGE_ERROR;
    }
  } catch (err) {
    if (err instanceof DaemonRequestError) {
      if (json) printJson({ error: err.name, message: err.message });
      else printHuman(`error: ${err.message}`);
      return err.status === 404 ? EXIT_CODES.NOT_FOUND : err.status === 409 ? EXIT_CODES.INVALID_STATE : EXIT_CODES.GENERIC_ERROR;
    }
    if (json) printJson({ error: (err as Error).name, message: (err as Error).message });
    else printHuman(`error: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }
}

main().then((code) => {
  // fetch()'s underlying undici keep-alive sockets can otherwise hold the
  // event loop open after the CLI has already printed its one JSON line.
  process.exitCode = code;
  process.exit(code);
});
