/**
 * Assembles a full `VisualTask` (frames + groups + marks + targets) from an
 * annotator store and grounded DOM targets, filling in each group's
 * `targetIds` (docs/ARCHITECTURE.md §6: InstructionGroup.targetIds).
 *
 * This is the seam Phase 4 (CLI submit) will call into once a daemon exists;
 * for now it is exercised directly by tests and the standalone submit-spike.
 */
import type { DomTarget, Frame, InstructionGroup, Mark, ReferenceAsset, VisualTask } from '@redpen/protocol/schema';
import { SCHEMA_VERSION } from '@redpen/protocol/schema';

export function assembleVisualTask(params: {
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
  frame: Frame;
  groups: readonly InstructionGroup[];
  marks: readonly Mark[];
  targets: readonly DomTarget[];
  references: readonly ReferenceAsset[];
  globalNote?: string;
}): VisualTask {
  const now = new Date().toISOString();

  const groupsWithTargets: InstructionGroup[] = params.groups.map((group) => {
    const targetIds = params.targets.filter((t) => t.groupIds.includes(group.id)).map((t) => t.id);
    return { ...group, targetIds };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    id: params.taskId,
    sessionId: params.sessionId,
    revision: 0,
    state: 'submitted',
    createdAt: now,
    updatedAt: now,
    workspace: { root: params.workspaceRoot },
    globalNote: params.globalNote,
    frames: [params.frame],
    groups: groupsWithTargets,
    marks: [...params.marks],
    targets: [...params.targets],
    references: [...params.references],
  };
}
