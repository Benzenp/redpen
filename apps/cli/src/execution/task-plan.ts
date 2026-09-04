import type { VisualTask } from '@redpen/protocol/schema';
import path from 'node:path';

export interface ExecutionTaskPlan {
  name: string;
  sourceGroupId: string;
  instruction: string;
}

function compactList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

/** Converts immutable visual instruction groups into self-contained agent work items. */
export function buildExecutionTaskPlans(task: VisualTask): ExecutionTaskPlan[] {
  const bundleRoot = path.join(task.workspace.root, '.redpen', 'tasks', task.id);
  return [...task.groups]
    .sort((left, right) => left.number - right.number)
    .map((group) => {
      const marks = task.marks.filter((mark) => mark.groupId === group.id);
      const targets = task.targets.filter((target) => group.targetIds.includes(target.id));
      const references = task.references.filter((reference) => group.referenceIds.includes(reference.id));
      const targetHints = targets.flatMap((target) => target.selectorHints).slice(0, 12);
      const lines = [
        `Visual task: ${task.id}`,
        `Instruction group: ${group.number}`,
        `User note: ${group.note?.trim() || '(no written note; inspect the annotated assets)'}`,
        `Mark types: ${compactList(marks.map((mark) => mark.type))}`,
        `DOM selector hints: ${compactList(targetHints)}`,
        `Reference assets: ${compactList(references.map((reference) => path.join(bundleRoot, reference.path)))}`,
        `Annotated frame: ${task.frames[0] ? path.join(bundleRoot, task.frames[0].annotated) : 'none'}`,
        `Overlay: ${task.frames[0] ? path.join(bundleRoot, task.frames[0].overlaySvg) : 'none'}`,
        '',
        'Implement only this instruction group in the assigned worktree. Treat selector hints as search clues, not guaranteed selectors. Read the annotated frame and linked references before editing. Keep the change isolated from other groups and leave the worktree ready for verification.',
      ];
      return {
        name: group.note?.trim() || `Instruction ${group.number}`,
        sourceGroupId: group.id,
        instruction: lines.join('\n'),
      };
    });
}
