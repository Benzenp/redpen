/**
 * Framework-independent Instruction Group / Mark state store
 * (docs/IMPLEMENTATION_PLAN.md Phase 2, docs/PRODUCT_INTENT.md §6.3/§7).
 *
 * This store owns everything the annotation UI needs *before* submission:
 * group creation/selection, mark authoring, undo/redo, and badge-cluster
 * computation. It never touches disk or the DOM — the React/canvas layer is
 * a thin renderer on top of this, and the same store is exercised directly
 * by unit tests without a browser.
 */
import { colorForGroupNumber } from './palette.js';
import type { InstructionGroup, Mark } from '@redpen/protocol/schema';
import { generateGroupId, generateMarkId } from '@redpen/protocol/ids';
import { rectsIntersect, intersectionArea } from '@redpen/protocol/geometry';

export interface AnnotatorSnapshot {
  groups: InstructionGroup[];
  marks: Mark[];
  activeGroupId: string;
}

export type MarkUpdate = Mark;

export interface EmptyGroupWarning {
  groupId: string;
  number: number;
}

export type AnnotatorStoreErrorCode =
  | 'invalid_annotation_mutation'
  | 'mark_not_found'
  | 'group_not_found'
  | 'group_not_empty'
  | 'last_group'
  | 'group_reference_limit';

export class AnnotatorStoreError extends Error {
  constructor(
    readonly code: AnnotatorStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnnotatorStoreError';
  }
}

export type NewMarkInput = Mark extends infer M
  ? M extends { type: 'mask' }
    ? Omit<M, 'id' | 'groupId' | 'opacity'> & { opacity?: number }
    : M extends { id: string; groupId: string }
      ? Omit<M, 'id' | 'groupId'>
      : never
  : never;

const MAX_HISTORY = 200;

export class AnnotatorStore {
  private groups: InstructionGroup[] = [];
  private marks: Mark[] = [];
  private activeGroupId = '';
  private undoStack: AnnotatorSnapshot[] = [];
  private redoStack: AnnotatorSnapshot[] = [];
  private nextGroupNumber = 2;

  constructor() {
    // "#1 기본 group 자동 생성" (docs/IMPLEMENTATION_PLAN.md Phase 2). Done inline
    // rather than via createGroup() so the initial group is not itself an
    // undoable action — undo on a fresh store must be a no-op.
    const group: InstructionGroup = {
      id: generateGroupId(),
      number: 1,
      color: colorForGroupNumber(1),
      state: 'draft',
      markIds: [],
      targetIds: [],
      referenceIds: [],
    };
    this.groups.push(group);
    this.activeGroupId = group.id;
  }

  private snapshot(): AnnotatorSnapshot {
    return structuredClone({ groups: this.groups, marks: this.marks, activeGroupId: this.activeGroupId });
  }

  private restore(snapshot: AnnotatorSnapshot): void {
    const state = structuredClone(snapshot);
    this.groups = state.groups;
    this.marks = state.marks;
    this.activeGroupId = state.activeGroupId;
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  getGroups(): readonly InstructionGroup[] {
    return structuredClone(this.groups);
  }

  getMarks(): readonly Mark[] {
    return structuredClone(this.marks);
  }

  getActiveGroupId(): string {
    return this.activeGroupId;
  }

  getMarksForGroup(groupId: string): Mark[] {
    return structuredClone(this.marks.filter((m) => m.groupId === groupId));
  }

  /** "새 지시" — next number and next palette color, never reusing a number. */
  createGroup(): InstructionGroup {
    this.pushHistory();
    const number = this.nextGroupNumber++;
    const group: InstructionGroup = {
      id: generateGroupId(),
      number,
      color: colorForGroupNumber(number),
      state: 'draft',
      markIds: [],
      targetIds: [],
      referenceIds: [],
    };
    this.groups.push(group);
    this.activeGroupId = group.id;
    return structuredClone(group);
  }

  setActiveGroup(groupId: string): void {
    if (!this.groups.some((g) => g.id === groupId)) {
      throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    }
    // Selecting a group is not itself undoable content, but keep it out of
    // history so undo/redo only ever rewinds drawing operations.
    this.activeGroupId = groupId;
  }

  setGroupNote(groupId: string, note: string | undefined): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    this.pushHistory();
    group.note = note;
    group.state = 'ready';
  }

  attachReference(groupId: string, referenceId: string): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    if (group.referenceIds.includes(referenceId)) return;
    if (group.referenceIds.length >= 3) {
      throw new AnnotatorStoreError('group_reference_limit', `group ${groupId} cannot have more than 3 references`);
    }
    this.pushHistory();
    group.referenceIds.push(referenceId);
  }

  detachReference(groupId: string, referenceId: string): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    if (!group.referenceIds.includes(referenceId)) return;
    this.pushHistory();
    group.referenceIds = group.referenceIds.filter((id) => id !== referenceId);
  }

  /** Adds a mark to the currently active group. */
  addMark(input: NewMarkInput): Mark {
    if (!this.activeGroupId) throw new AnnotatorStoreError('group_not_found', 'no active group');
    this.pushHistory();
    const mark = {
      ...input,
      ...(input.type === 'mask' ? { opacity: input.opacity ?? 0.5 } : {}),
      id: generateMarkId(),
      groupId: this.activeGroupId,
    } as Mark;
    this.marks.push(mark);
    const group = this.groups.find((g) => g.id === this.activeGroupId);
    if (group) group.markIds.push(mark.id);
    return structuredClone(mark);
  }

  updateMarks(updates: readonly MarkUpdate[]): void {
    if (updates.length === 0) {
      throw new AnnotatorStoreError('invalid_annotation_mutation', 'at least one mark update is required');
    }
    const existing = new Map(this.marks.map((mark) => [mark.id, mark]));
    const updateIds = new Set<string>();
    for (const update of updates) {
      if (updateIds.has(update.id)) {
        throw new AnnotatorStoreError('invalid_annotation_mutation', `duplicate markId: ${update.id}`);
      }
      updateIds.add(update.id);
      const mark = existing.get(update.id);
      if (!mark) throw new AnnotatorStoreError('mark_not_found', `unknown markId: ${update.id}`);
      if (mark.type !== update.type || mark.frameId !== update.frameId || mark.groupId !== update.groupId) {
        throw new AnnotatorStoreError('invalid_annotation_mutation', `mark identity cannot change: ${update.id}`);
      }
    }
    if (updates.every((update) => JSON.stringify(existing.get(update.id)) === JSON.stringify(update))) return;
    this.pushHistory();
    const replacements = new Map(updates.map((mark) => [mark.id, structuredClone(mark)]));
    this.marks = this.marks.map((mark) => replacements.get(mark.id) ?? mark);
  }

  reassignMarks(markIds: readonly string[], groupId: string): void {
    const destination = this.groups.find((group) => group.id === groupId);
    if (!destination) throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    this.assertKnownUniqueMarkIds(markIds);
    if (markIds.every((id) => this.marks.find((mark) => mark.id === id)?.groupId === groupId)) return;
    this.pushHistory();
    const ids = new Set(markIds);
    this.marks = this.marks.map((mark) => ids.has(mark.id) ? { ...mark, groupId } : mark);
    for (const group of this.groups) {
      group.markIds = group.markIds.filter((id) => !ids.has(id));
    }
    destination.markIds.push(...markIds);
  }

  deleteMarks(markIds: readonly string[]): void {
    this.assertKnownUniqueMarkIds(markIds);
    this.pushHistory();
    const ids = new Set(markIds);
    this.marks = this.marks.filter((mark) => !ids.has(mark.id));
    for (const group of this.groups) group.markIds = group.markIds.filter((id) => !ids.has(id));
  }

  updateMaskStyle(markIds: readonly string[], opacity: number): void {
    if (!Number.isFinite(opacity) || opacity < 0.1 || opacity > 1) {
      throw new AnnotatorStoreError('invalid_annotation_mutation', 'mask opacity must be between 0.1 and 1');
    }
    this.assertKnownUniqueMarkIds(markIds);
    if (!markIds.every((id) => this.marks.find((mark) => mark.id === id)?.type === 'mask')) {
      throw new AnnotatorStoreError('invalid_annotation_mutation', 'mask style can only be applied to masks');
    }
    if (markIds.every((id) => {
      const mark = this.marks.find((candidate) => candidate.id === id);
      return mark?.type === 'mask' && mark.opacity === opacity;
    })) return;
    this.pushHistory();
    const ids = new Set(markIds);
    this.marks = this.marks.map((mark) => mark.type === 'mask' && ids.has(mark.id) ? { ...mark, opacity } : mark);
  }

  deleteGroup(groupId: string): void {
    if (this.groups.length === 1) throw new AnnotatorStoreError('last_group', 'cannot delete the last group');
    const group = this.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new AnnotatorStoreError('group_not_found', `unknown groupId: ${groupId}`);
    if (group.markIds.length > 0 || group.targetIds.length > 0 || group.referenceIds.length > 0) {
      throw new AnnotatorStoreError('group_not_empty', `cannot delete non-empty group: ${groupId}`);
    }
    this.pushHistory();
    this.groups = this.groups.filter((candidate) => candidate.id !== groupId);
    if (this.activeGroupId === groupId) this.activeGroupId = this.groups[0].id;
  }

  private assertKnownUniqueMarkIds(markIds: readonly string[]): void {
    if (markIds.length === 0) {
      throw new AnnotatorStoreError('invalid_annotation_mutation', 'at least one markId is required');
    }
    const existing = new Set(this.marks.map((mark) => mark.id));
    const unique = new Set<string>();
    for (const markId of markIds) {
      if (unique.has(markId)) {
        throw new AnnotatorStoreError('invalid_annotation_mutation', `duplicate markId: ${markId}`);
      }
      unique.add(markId);
      if (!existing.has(markId)) throw new AnnotatorStoreError('mark_not_found', `unknown markId: ${markId}`);
    }
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.snapshot());
    const previous = this.undoStack.pop()!;
    this.restore(previous);
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  redo(): boolean {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.snapshot());
    const next = this.redoStack.pop()!;
    this.restore(next);
    return true;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Groups with zero marks are not allowed to submit (docs/PRODUCT_INTENT.md §6.4). */
  findEmptyGroups(): EmptyGroupWarning[] {
    return this.groups
      .filter((g) => g.markIds.length === 0)
      .map((g) => ({ groupId: g.id, number: g.number }));
  }

  canSubmit(): boolean {
    return this.findEmptyGroups().length === 0 && this.groups.length > 0;
  }

  /**
   * Clusters a group's marks into disconnected spatial regions so the UI can
   * repeat the group's number badge over each cluster
   * (docs/PRODUCT_INTENT.md §7: "같은 그룹이 여러 화면 영역에 걸치면 badge를 각
   * 군집에 반복 표시한다"). Two marks are in the same cluster if their bounds
   * intersect or are within `proximityPx` of each other.
   */
  computeBadgeClusters(groupId: string, proximityPx = 24): Array<{ x: number; y: number; width: number; height: number }> {
    const marks = this.getMarksForGroup(groupId);
    if (marks.length === 0) return [];

    const expanded = marks.map((m) => ({
      x: m.bounds.x - proximityPx,
      y: m.bounds.y - proximityPx,
      width: m.bounds.width + proximityPx * 2,
      height: m.bounds.height + proximityPx * 2,
    }));

    const parent = marks.map((_, i) => i);
    function find(i: number): number {
      while (parent[i] !== i) i = parent[i];
      return i;
    }
    function union(a: number, b: number) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    for (let i = 0; i < expanded.length; i++) {
      for (let j = i + 1; j < expanded.length; j++) {
        if (rectsIntersect(expanded[i], expanded[j]) || intersectionArea(expanded[i], expanded[j]) > 0) {
          union(i, j);
        }
      }
    }

    const clusters = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (let i = 0; i < marks.length; i++) {
      const root = find(i);
      const bounds = marks[i].bounds;
      const existing = clusters.get(root);
      if (!existing) {
        clusters.set(root, {
          minX: bounds.x,
          minY: bounds.y,
          maxX: bounds.x + bounds.width,
          maxY: bounds.y + bounds.height,
        });
      } else {
        existing.minX = Math.min(existing.minX, bounds.x);
        existing.minY = Math.min(existing.minY, bounds.y);
        existing.maxX = Math.max(existing.maxX, bounds.x + bounds.width);
        existing.maxY = Math.max(existing.maxY, bounds.y + bounds.height);
      }
    }

    return Array.from(clusters.values()).map((c) => ({
      x: c.minX,
      y: c.minY,
      width: c.maxX - c.minX,
      height: c.maxY - c.minY,
    }));
  }
}
