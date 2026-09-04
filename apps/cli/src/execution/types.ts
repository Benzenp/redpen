export type CandidateStatus = 'draft' | 'sealed' | 'published';

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
  remote?: string;
  publishedAt?: string;
}

export interface ExecutionTask {
  id: string;
  name: string;
  sourceGroupId?: string;
  instruction?: string;
  candidates: ExecutionCandidate[];
}

/** Persistent execution metadata; intentionally independent from VisualTask. */
export interface ExecutionRun {
  id: string;
  workspaceRoot: string;
  baseCommit: string;
  sourceTaskId?: string;
  finalPublication?: {
    commit: string;
    remote: string;
    targetBranch: string;
    includedTaskIds: string[];
    commits: string[];
    publishedAt: string;
  };
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

export interface FinalPublishResult {
  branch: string;
  commit: string;
  remote: string;
  targetBranch: string;
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

export class VerificationError extends ExecutionError {
  constructor(
    message: string,
    readonly details: { command: string[]; cwd: string; stdout: string; stderr: string },
  ) {
    super(message, 'VERIFICATION_FAILED');
    this.name = 'VerificationError';
  }
}
