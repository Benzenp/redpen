/**
 * Review revision creation (docs/IMPLEMENTATION_PLAN.md Phase 6: "review에서
 * 새 annotation revision 생성", "revision history와 parent task 연결").
 *
 * A revision is an entirely new immutable VisualTask, never a mutation of
 * the parent — the parent's frames/marks/targets/images stay exactly as
 * they were submitted (docs/IMPLEMENTATION_PLAN.md Phase 6 완료 조건:
 * "이전 이미지와 지시는 변경되지 않고 보존된다").
 */
import type { VisualTask, DomTarget, Frame, InstructionGroup, Mark, ReferenceAsset } from '@redpen/protocol/schema';

export interface CreateRevisionInput {
  newTaskId: string;
  parentTask: VisualTask;
  frame: Frame;
  groups: readonly InstructionGroup[];
  marks: readonly Mark[];
  targets: readonly DomTarget[];
  references: readonly ReferenceAsset[];
  globalNote?: string;
}

export function createRevision(input: CreateRevisionInput): VisualTask {
  const now = new Date().toISOString();
  return {
    schemaVersion: input.parentTask.schemaVersion,
    id: input.newTaskId,
    sessionId: input.parentTask.sessionId,
    revision: input.parentTask.revision + 1,
    parentTaskId: input.parentTask.id,
    state: 'submitted',
    createdAt: now,
    updatedAt: now,
    workspace: input.parentTask.workspace,
    globalNote: input.globalNote,
    frames: [input.frame],
    groups: [...input.groups],
    marks: [...input.marks],
    targets: [...input.targets],
    references: [...input.references],
  };
}

/** Walks a revision chain from `task` back to the original (revision 0) task, using a lookup function. */
export async function resolveRevisionChain(
  task: VisualTask,
  lookupById: (id: string) => Promise<VisualTask | null>,
): Promise<VisualTask[]> {
  const chain: VisualTask[] = [task];
  let current = task;
  while (current.parentTaskId) {
    const parent = await lookupById(current.parentTaskId);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain.reverse(); // oldest first
}
