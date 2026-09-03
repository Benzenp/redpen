export type CandidateStatus = 'draft' | 'sealed';

export interface DiffSummary {
  changedFiles: string[];
  stat: string;
}

export interface ExecutionCandidate {
  id: string;
  branch: string;
  worktreePath: string;
  status: CandidateStatus;
  selected: boolean;
  commit?: string;
  diffSummary?: DiffSummary;
  createdAt: string;
  sealedAt?: string;
}

export interface ExecutionTask {
  id: string;
  name: string;
  candidates: ExecutionCandidate[];
}

/** Persistent execution metadata; intentionally independent from VisualTask. */
export interface ExecutionRun {
  id: string;
  workspaceRoot: string;
  baseCommit: string;
  tasks: ExecutionTask[];
  createdAt: string;
  updatedAt: string;
}

export interface CandidateInspection {
  clean: boolean;
  headCommit: string;
  changedFiles: Array<{ status: string; path: string }>;
  stat: string;
  patch: string;
}

export interface IntegrationResult {
  branch: string;
  worktreePath: string;
  baseCommit: string;
  includedTaskIds: string[];
  commits: string[];
}

export class ExecutionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export class CherryPickError extends ExecutionError {
  constructor(
    message: string,
    readonly details: { branch: string; worktreePath: string; candidateId: string; commit: string; stderr: string },
  ) {
    super(message, 'CHERRY_PICK_FAILED');
    this.name = 'CherryPickError';
  }
}
