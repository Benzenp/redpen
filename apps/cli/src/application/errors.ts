export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class NoActiveCaptureError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} has no pending capture to submit; call freeze first`);
    this.name = 'NoActiveCaptureError';
  }
}
