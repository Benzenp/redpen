/**
 * Thin HTTP client the CLI uses to talk to the daemon (docs/ARCHITECTURE.md
 * §3.3 "CLI, daemon route, MCP tool은 모두 이 service layer를 호출한다" — the
 * CLI process itself has no business logic, only this client + argument
 * parsing + output formatting).
 */
import { ensureDaemonRunning } from './ensure-daemon.js';

export class DaemonRequestError extends Error {
  constructor(public readonly status: number, public readonly body: { error?: string; message?: string }) {
    super(body.message ?? body.error ?? `daemon request failed with status ${status}`);
    this.name = 'DaemonRequestError';
  }
}

export class DaemonClient {
  private constructor(private readonly baseUrl: string, private readonly token: string) {}

  static async connect(): Promise<DaemonClient> {
    const discovery = await ensureDaemonRunning();
    return new DaemonClient(`http://127.0.0.1:${discovery.port}`, discovery.token);
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json();
    if (!res.ok) {
      throw new DaemonRequestError(res.status, parsed as { error?: string; message?: string });
    }
    return parsed as T;
  }

  openSession(url: string, workspaceRoot: string) {
    return this.request<{ session: unknown }>('POST', '/sessions', { url, workspaceRoot });
  }

  listSessions(workspaceRoot?: string) {
    const qs = workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : '';
    return this.request<{ sessions: unknown[] }>('GET', `/sessions${qs}`);
  }

  getSession(sessionId: string) {
    return this.request<{ session: unknown }>('GET', `/sessions/${sessionId}`);
  }

  freeze(sessionId: string) {
    return this.request<{ session: unknown }>('POST', `/sessions/${sessionId}/freeze`);
  }

  submit(sessionId: string, globalNote?: string) {
    return this.request<{ session: unknown; taskId: string }>('POST', `/sessions/${sessionId}/submit`, { globalNote });
  }

  wait(sessionId: string, timeoutSeconds: number) {
    return this.request<{ taskId: string | null; session: unknown }>(
      'GET',
      `/sessions/${sessionId}/wait?timeout=${timeoutSeconds}`,
    );
  }

  claim(sessionId: string) {
    return this.request<{ session: unknown }>('POST', `/sessions/${sessionId}/claim`);
  }

  reviewReady(sessionId: string) {
    return this.request<{ session: unknown }>('POST', `/sessions/${sessionId}/review-ready`);
  }

  accept(sessionId: string) {
    return this.request<{ session: unknown }>('POST', `/sessions/${sessionId}/accept`);
  }

  cancelSession(sessionId: string) {
    return this.request<{ session: unknown }>('POST', `/sessions/${sessionId}/cancel`);
  }

  closeSession(sessionId: string, shutdownIfIdle = false) {
    const query = shutdownIfIdle ? '?shutdownIfIdle=1' : '';
    return this.request<{ ok: boolean }>('DELETE', `/sessions/${sessionId}${query}`);
  }

  getTask(taskId: string, workspaceRoot: string) {
    return this.request<{ task: unknown }>('GET', `/tasks/${taskId}?workspaceRoot=${encodeURIComponent(workspaceRoot)}`);
  }

  listTasks(workspaceRoot: string) {
    return this.request<{ taskIds: string[] }>('GET', `/tasks?workspaceRoot=${encodeURIComponent(workspaceRoot)}`);
  }
}
