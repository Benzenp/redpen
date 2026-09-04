import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { stat } from 'node:fs/promises';
import { assertLoopbackUrl } from '../application/url-policy.js';

const MAX_CONCURRENT_PROCESSES = 19;
const MAX_ID_LENGTH = 128;
const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_ENVIRONMENT_VALUE_LENGTH = 4096;
const MAX_ENVIRONMENT_BYTES = 32 * 1024;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const READY_POLL_INTERVAL_MS = 100;
const STOP_GRACE_MS = 1_000;

export type ManagedExecutionProcessKind = 'agent' | 'candidate-server' | 'preview-server';
export type ManagedExecutionProcessStatus = 'running' | 'ready' | 'exited' | 'failed' | 'stopped';

export interface StartManagedExecutionProcessInput {
  id: string;
  kind: ManagedExecutionProcessKind;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  readyUrl?: string;
  readyTimeoutMs?: number;
}

export interface ManagedExecutionProcess {
  id: string;
  kind: ManagedExecutionProcessKind;
  cwd: string;
  command: string;
  args: string[];
  pid: number;
  status: ManagedExecutionProcessStatus;
  startedAt: string;
  readyAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Kill = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export interface ManagedExecutionProcessManagerOptions {
  spawn?: Spawn;
  fetch?: Fetch;
  platform?: NodeJS.Platform;
  kill?: Kill;
}

interface ProcessEntry {
  record: ManagedExecutionProcess;
  child: ChildProcess;
  stdout: Buffer;
  stderr: Buffer;
  exit: Promise<ManagedExecutionProcess>;
  resolveExit: (record: ManagedExecutionProcess) => void;
  settled: boolean;
  stopRequested: boolean;
}

function appendOutput(current: Buffer, chunk: Buffer): Buffer {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_LIMIT_BYTES ? combined : combined.subarray(combined.length - OUTPUT_LIMIT_BYTES);
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function invalid(message: string): never {
  throw new Error(`invalid managed process: ${message}`);
}

function validateInput(input: StartManagedExecutionProcessInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id) || input.id.length > MAX_ID_LENGTH) invalid('id');
  if (!['agent', 'candidate-server', 'preview-server'].includes(input.kind)) invalid('kind');
  if (typeof input.cwd !== 'string' || input.cwd.length === 0 || hasNul(input.cwd)) invalid('cwd');
  if (typeof input.command !== 'string' || input.command.length === 0 || input.command.length > MAX_COMMAND_LENGTH || hasNul(input.command)) invalid('command');
  if (!Array.isArray(input.args) || input.args.length > MAX_ARGUMENTS) invalid('args');
  let argumentBytes = 0;
  for (const arg of input.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARGUMENT_LENGTH || hasNul(arg)) invalid('args');
    argumentBytes += Buffer.byteLength(arg);
  }
  if (argumentBytes > MAX_ARGUMENT_BYTES) invalid('args');
  if (input.env !== undefined) {
    const entries = Object.entries(input.env);
    if (entries.length > MAX_ENVIRONMENT_ENTRIES) invalid('env');
    let environmentBytes = 0;
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || hasNul(key) || typeof value !== 'string' || value.length > MAX_ENVIRONMENT_VALUE_LENGTH || hasNul(value)) invalid('env');
      environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    }
    if (environmentBytes > MAX_ENVIRONMENT_BYTES) invalid('env');
  }
  if (input.readyTimeoutMs !== undefined && (!Number.isInteger(input.readyTimeoutMs) || input.readyTimeoutMs <= 0 || input.readyTimeoutMs > 10 * 60_000)) invalid('readyTimeoutMs');
}

function isLive(status: ManagedExecutionProcessStatus): boolean {
  return status === 'running' || status === 'ready';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ManagedExecutionProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly spawn: Spawn;
  private readonly fetch: Fetch;
  private readonly platform: NodeJS.Platform;
  private readonly kill: Kill;

  constructor(options: ManagedExecutionProcessManagerOptions = {}) {
    this.spawn = options.spawn ?? crossSpawn;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.platform = options.platform ?? process.platform;
    this.kill = options.kill ?? process.kill.bind(process);
  }

  async start(input: StartManagedExecutionProcessInput): Promise<ManagedExecutionProcess> {
    validateInput(input);
    if (input.readyUrl) assertLoopbackUrl(input.readyUrl);
    const cwd = await stat(input.cwd);
    if (!cwd.isDirectory()) invalid('cwd must be a directory');
    const existing = this.entries.get(input.id);
    if (existing && isLive(existing.record.status)) throw new Error(`managed process already live: ${input.id}`);
    if (this.liveCount() >= MAX_CONCURRENT_PROCESSES) throw new Error(`managed process limit reached: ${MAX_CONCURRENT_PROCESSES}`);

    const child = this.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      shell: false,
      detached: this.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (!child.pid) throw new Error(`managed process did not provide a pid: ${input.id}`);

    let resolveExit!: (record: ManagedExecutionProcess) => void;
    const record: ManagedExecutionProcess = {
      id: input.id, kind: input.kind, cwd: input.cwd, command: input.command, args: [...input.args], pid: child.pid,
      status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '',
    };
    const entry: ProcessEntry = {
      record, child, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), settled: false, stopRequested: false,
      exit: new Promise((resolve) => { resolveExit = resolve; }), resolveExit,
    };
    this.entries.set(input.id, entry);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      entry.stdout = appendOutput(entry.stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      entry.record.stdout = entry.stdout.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      entry.stderr = appendOutput(entry.stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      entry.record.stderr = entry.stderr.toString('utf8');
    });
    child.once('error', (error) => this.finish(entry, null, null, error));
    // `close` follows stream closure, unlike `exit`; finishing here keeps
    // trailing stdout/stderr inspectable when wait resolves.
    child.once('close', (code, signal) => this.finish(entry, code, signal, null));

    if (!input.readyUrl) return this.snapshot(record);
    try {
      await this.waitForReady(entry, input.readyUrl, input.readyTimeoutMs ?? 30_000);
      return this.snapshot(record);
    } catch (error) {
      if (isLive(record.status)) await this.stopEntry(entry);
      throw error;
    }
  }

  get(id: string): ManagedExecutionProcess | undefined {
    const entry = this.entries.get(id);
    return entry ? this.snapshot(entry.record) : undefined;
  }

  list(): ManagedExecutionProcess[] {
    return [...this.entries.values()].map((entry) => this.snapshot(entry.record));
  }

  async wait(id: string): Promise<ManagedExecutionProcess> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`managed process not found: ${id}`);
    return this.snapshot(await entry.exit);
  }

  async stop(id: string): Promise<ManagedExecutionProcess> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`managed process not found: ${id}`);
    if (isLive(entry.record.status)) await this.stopEntry(entry);
    return this.snapshot(entry.record);
  }

  async stopAll(): Promise<ManagedExecutionProcess[]> {
    await Promise.all([...this.entries.values()].filter((entry) => isLive(entry.record.status)).map((entry) => this.stopEntry(entry)));
    return this.list();
  }

  private liveCount(): number {
    return [...this.entries.values()].filter((entry) => isLive(entry.record.status)).length;
  }

  private snapshot(record: ManagedExecutionProcess): ManagedExecutionProcess {
    return { ...record, args: [...record.args] };
  }

  private finish(entry: ProcessEntry, code: number | null, signal: NodeJS.Signals | null, error: Error | null): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.record.exitedAt = new Date().toISOString();
    entry.record.exitCode = code;
    entry.record.signal = signal;
    if (error) {
      entry.stderr = appendOutput(entry.stderr, Buffer.from(`${error.message}\n`));
      entry.record.stderr = entry.stderr.toString('utf8');
    }
    entry.record.status = entry.stopRequested ? 'stopped' : (error || code !== 0 ? 'failed' : 'exited');
    entry.resolveExit(entry.record);
  }

  private async waitForReady(entry: ProcessEntry, readyUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.settled) throw new Error(`managed process exited before ready: ${entry.record.id}`);
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const response = await this.fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(1_000, remaining)) });
        if (response.status >= 200 && response.status <= 499) {
          entry.record.status = 'ready';
          entry.record.readyAt = new Date().toISOString();
          return;
        }
      } catch {
        // A refused connection is expected while a dev server starts.
      }
      await delay(Math.min(READY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`managed process readiness timed out: ${entry.record.id}`);
  }

  private async stopEntry(entry: ProcessEntry): Promise<void> {
    entry.stopRequested = true;
    await this.terminateTree(entry);
    await entry.exit;
  }

  private async terminateTree(entry: ProcessEntry): Promise<void> {
    if (this.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        let taskkill: ChildProcess;
        try {
          taskkill = this.spawn('taskkill', ['/pid', String(entry.record.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        } catch (error) {
          reject(error);
          return;
        }
        taskkill.once('error', reject);
        taskkill.once('exit', (code) => code === 0 || entry.settled ? resolve() : reject(new Error(`taskkill failed for managed process ${entry.record.id}`)));
      });
      return;
    }
    this.signalGroup(entry.record.pid, 'SIGTERM');
    const exited = await Promise.race([entry.exit.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
    if (!exited) this.signalGroup(entry.record.pid, 'SIGKILL');
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.kill(-pid, signal);
    } catch (error: unknown) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
