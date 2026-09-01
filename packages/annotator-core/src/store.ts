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

export interface EmptyGroupWarning {
  groupId: string;
  number: number;
}

export type NewMarkInput = Mark extends infer M
  ? M extends { id: string; groupId: string }
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
    return {
      groups: this.groups.map((g) => ({
        ...g,
        markIds: [...g.markIds],
        targetIds: [...g.targetIds],
        referenceIds: [...g.referenceIds],
      })),
      marks: [...this.marks],
      activeGroupId: this.activeGroupId,
    };
  }

  private restore(snapshot: AnnotatorSnapshot): void {
    this.groups = snapshot.groups.map((g) => ({
      ...g,
      markIds: [...g.markIds],
      targetIds: [...g.targetIds],
      referenceIds: [...g.referenceIds],
    }));
    this.marks = [...snapshot.marks];
    this.activeGroupId = snapshot.activeGroupId;
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  getGroups(): readonly InstructionGroup[] {
    return this.groups;
  }

  getMarks(): readonly Mark[] {
    return this.marks;
  }

  getActiveGroupId(): string {
    return this.activeGroupId;
  }

  getMarksForGroup(groupId: string): Mark[] {
    return this.marks.filter((m) => m.groupId === groupId);
  }

  /** "새 지시" — next number and next palette color, never reusing a number. */
  createGroup(): InstructionGroup {
    this.pushHistory();
    const number = this.groups.length + 1;
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
    return group;
  }

  setActiveGroup(groupId: string): void {
    if (!this.groups.some((g) => g.id === groupId)) {
      throw new Error(`unknown groupId: ${groupId}`);
    }
    // Selecting a group is not itself undoable content, but keep it out of
    // history so undo/redo only ever rewinds drawing operations.
    this.activeGroupId = groupId;
  }

  setGroupNote(groupId: string, note: string | undefined): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown groupId: ${groupId}`);
    this.pushHistory();
    group.note = note;
    group.state = 'ready';
  }

  attachReference(groupId: string, referenceId: string): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown groupId: ${groupId}`);
    if (group.referenceIds.includes(referenceId)) return;
    if (group.referenceIds.length >= 3) {
      throw new Error(`group ${groupId} cannot have more than 3 references`);
    }
    this.pushHistory();
    group.referenceIds.push(referenceId);
  }

  detachReference(groupId: string, referenceId: string): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown groupId: ${groupId}`);
    if (!group.referenceIds.includes(referenceId)) return;
    this.pushHistory();
    group.referenceIds = group.referenceIds.filter((id) => id !== referenceId);
  }

  /** Adds a mark to the currently active group. */
  addMark(input: NewMarkInput): Mark {
    if (!this.activeGroupId) throw new Error('no active group');
    this.pushHistory();
    const mark = { ...input, id: generateMarkId(), groupId: this.activeGroupId } as Mark;
    this.marks.push(mark);
    const group = this.groups.find((g) => g.id === this.activeGroupId);
    if (group) group.markIds.push(mark.id);
    return mark;
  }

  removeMark(markId: string): void {
    this.pushHistory();
    const mark = this.marks.find((m) => m.id === markId);
    if (!mark) return;
    this.marks = this.marks.filter((m) => m.id !== markId);
    const group = this.groups.find((g) => g.id === mark.groupId);
    if (group) group.markIds = group.markIds.filter((id) => id !== markId);
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.snapshot());
    const previous = this.undoStack.pop()!;
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.snapshot());
    const next = this.redoStack.pop()!;
    this.restore(next);
    return true;
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
