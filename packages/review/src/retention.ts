/**
 * Task deletion and retention policy (docs/IMPLEMENTATION_PLAN.md Phase 6:
 * "task 삭제 및 retention 정책").
 *
 * MVP policy: a task bundle is eligible for deletion once it is `done` or
 * `cancelled` AND older than `maxAgeMs`. Tasks that are the parent of a
 * later revision are never deleted while that revision still exists, so a
 * revision chain's history stays resolvable
 * (docs/IMPLEMENTATION_PLAN.md Phase 6 완료 조건).
 */
import type { VisualTask } from '@redpen/protocol/schema';

export interface RetentionPolicy {
  maxAgeMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const DELETABLE_STATES = new Set(['done', 'cancelled']);

export function isEligibleForDeletion(task: VisualTask, now: Date, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): boolean {
  if (!DELETABLE_STATES.has(task.state)) return false;
  const updatedAt = new Date(task.updatedAt).getTime();
  return now.getTime() - updatedAt >= policy.maxAgeMs;
}

/**
 * Filters a candidate list of tasks to those eligible for deletion, excluding
 * any task that is referenced as a `parentTaskId` by another still-existing
 * task in the same set (or by a task outside the set, via `referencedParentIds`).
 */
export function selectTasksForDeletion(
  tasks: readonly VisualTask[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): VisualTask[] {
  const referencedParentIds = new Set(tasks.map((t) => t.parentTaskId).filter((id): id is string => Boolean(id)));
  return tasks.filter((task) => isEligibleForDeletion(task, now, policy) && !referencedParentIds.has(task.id));
}
