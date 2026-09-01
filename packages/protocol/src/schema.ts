/**
 * Canonical Redpen protocol schema (docs/ARCHITECTURE.md §6, §2.2).
 *
 * This is the ONE canonical task/session format. UI internal state, the
 * annotation canvas library's native state, and MCP response DTOs must be
 * adapted into this schema — never persisted directly.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const viewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  deviceScaleFactor: z.number().positive(),
});

const scrollSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const sessionStateSchema = z.enum([
  'browsing',
  'annotating',
  'submitted',
  'working',
  'review',
  'done',
  'cancelled',
  'error',
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const taskStateSchema = z.enum(['submitted', 'working', 'review', 'done', 'cancelled']);
export type TaskState = z.infer<typeof taskStateSchema>;

export const groupStateSchema = z.enum(['draft', 'ready']);
export type GroupState = z.infer<typeof groupStateSchema>;

export const domTargetRelationSchema = z.enum([
  'intersects',
  'contains',
  'nearest',
  'arrow-source',
  'arrow-destination',
  'line-start',
  'line-end',
]);
export type DomTargetRelation = z.infer<typeof domTargetRelationSchema>;

const elementSummarySchema = z.object({
  tag: z.string(),
  role: z.string().nullable().optional(),
  accessibleName: z.string().nullable().optional(),
  textSummary: z.string().nullable().optional(),
});
export type ElementSummary = z.infer<typeof elementSummarySchema>;

export const lastErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type LastError = z.infer<typeof lastErrorSchema>;

export const visualSessionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  state: sessionStateSchema,
  workspaceRoot: z.string().min(1),
  targetUrl: z.string().min(1),
  activeTaskId: z.string().optional(),
  lastError: lastErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VisualSession = z.infer<typeof visualSessionSchema>;

export const frameSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  screenshot: z.string().min(1),
  annotated: z.string().min(1),
  overlaySvg: z.string().min(1),
  viewport: viewportSchema,
  scroll: scrollSchema,
  capturedAt: z.string().datetime(),
});
export type Frame = z.infer<typeof frameSchema>;

export const instructionGroupSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  color: z.string().min(1),
  note: z.string().optional(),
  state: groupStateSchema,
  markIds: z.array(z.string().min(1)),
  targetIds: z.array(z.string().min(1)),
  referenceIds: z.array(z.string().min(1)).max(3).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'referenceIds must be unique' },
  ),
});
export type InstructionGroup = z.infer<typeof instructionGroupSchema>;

const markBaseSchema = z.object({
  id: z.string().min(1),
  frameId: z.string().min(1),
  groupId: z.string().min(1),
  bounds: rectSchema,
  normalizedBounds: rectSchema,
});

export const freehandMarkSchema = markBaseSchema.extend({
  type: z.literal('freehand'),
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(1),
});

export const arrowMarkSchema = markBaseSchema.extend({
  type: z.literal('arrow'),
  from: z.object({ x: z.number(), y: z.number() }),
  to: z.object({ x: z.number(), y: z.number() }),
});

export const lineMarkSchema = markBaseSchema.extend({
  type: z.literal('line'),
  from: z.object({ x: z.number(), y: z.number() }),
  to: z.object({ x: z.number(), y: z.number() }),
});

export const rectangleMarkSchema = markBaseSchema.extend({
  type: z.literal('rectangle'),
});

export const ellipseMarkSchema = markBaseSchema.extend({
  type: z.literal('ellipse'),
});

export const textMarkSchema = markBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
  anchor: z.object({ x: z.number(), y: z.number() }),
});

export const maskMarkSchema = markBaseSchema.extend({
  type: z.literal('mask'),
  opacity: z.number().min(0.1).max(1),
});

export const patchMarkSchema = markBaseSchema.extend({
  type: z.literal('patch'),
  sourceRect: rectSchema,
});

export const markSchema = z.discriminatedUnion('type', [
  freehandMarkSchema,
  arrowMarkSchema,
  lineMarkSchema,
  rectangleMarkSchema,
  ellipseMarkSchema,
  textMarkSchema,
  maskMarkSchema,
  patchMarkSchema,
]);
export type Mark = z.infer<typeof markSchema>;
export type MarkBase = z.infer<typeof markBaseSchema>;

export const annotationMarkCreateRequestSchema = z.discriminatedUnion('type', [
  freehandMarkSchema.omit({ id: true, groupId: true }).strict(),
  arrowMarkSchema.omit({ id: true, groupId: true }).strict(),
  lineMarkSchema.omit({ id: true, groupId: true }).strict(),
  rectangleMarkSchema.omit({ id: true, groupId: true }).strict(),
  ellipseMarkSchema.omit({ id: true, groupId: true }).strict(),
  textMarkSchema.omit({ id: true, groupId: true }).strict(),
  maskMarkSchema.omit({ id: true, groupId: true }).strict(),
  patchMarkSchema.omit({ id: true, groupId: true }).strict(),
]);
export type AnnotationMarkCreateRequest = z.infer<typeof annotationMarkCreateRequestSchema>;

const markIdListSchema = z.array(z.string().min(1)).min(1).max(200).refine(
  (ids) => new Set(ids).size === ids.length,
  { message: 'markIds must be unique' },
);

/** Request contracts for atomic annotator selection mutations. */
export const annotationMarkUpdateRequestSchema = z.object({
  marks: z.array(markSchema).min(1).max(200).refine(
    (marks) => new Set(marks.map((mark) => mark.id)).size === marks.length,
    { message: 'mark IDs must be unique' },
  ),
}).strict();
export type AnnotationMarkUpdateRequest = z.infer<typeof annotationMarkUpdateRequestSchema>;

export const annotationMarkReassignRequestSchema = z.object({
  markIds: markIdListSchema,
  groupId: z.string().min(1),
}).strict();
export type AnnotationMarkReassignRequest = z.infer<typeof annotationMarkReassignRequestSchema>;

export const annotationMarkDeleteRequestSchema = z.object({
  markIds: markIdListSchema,
}).strict();
export type AnnotationMarkDeleteRequest = z.infer<typeof annotationMarkDeleteRequestSchema>;

export const annotationMaskStyleRequestSchema = z.object({
  markIds: markIdListSchema,
  opacity: z.number().min(0.1).max(1),
}).strict();
export type AnnotationMaskStyleRequest = z.infer<typeof annotationMaskStyleRequestSchema>;

// computedLayout allowlist per docs/ARCHITECTURE.md §6.
export const COMPUTED_LAYOUT_ALLOWLIST = [
  'display',
  'position',
  'gap',
  'padding',
  'margin',
  'width',
  'height',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
] as const;

const computedLayoutSchema = z.record(z.string(), z.string()).refine(
  (obj) => Object.keys(obj).every((key) => (COMPUTED_LAYOUT_ALLOWLIST as readonly string[]).includes(key)),
  { message: 'computedLayout keys must be in COMPUTED_LAYOUT_ALLOWLIST' },
);

export const domTargetSchema = z.object({
  id: z.string().min(1),
  frameId: z.string().min(1),
  groupIds: z.array(z.string().min(1)),
  rect: rectSchema,
  tag: z.string().min(1),
  role: z.string().nullable().optional(),
  accessibleName: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  selectorHints: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  relation: domTargetRelationSchema,
  context: z
    .object({
      parent: elementSummarySchema.optional(),
      siblings: z.array(elementSummarySchema).optional(),
      computedLayout: computedLayoutSchema.optional(),
    })
    .optional(),
});
export type DomTarget = z.infer<typeof domTargetSchema>;

export const referenceAssetSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  path: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  createdAt: z.string().datetime(),
  label: z.string().optional(),
}).superRefine((reference, context) => {
  if (reference.fileName !== `${reference.id}.png`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fileName'], message: 'reference fileName must match its id' });
  }
  if (reference.path !== `references/${reference.fileName}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'reference path must stay inside task references/' });
  }
});
export type ReferenceAsset = z.infer<typeof referenceAssetSchema>;

export const visualTaskSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  /**
   * Links a review revision back to the task it was created from
   * (docs/IMPLEMENTATION_PLAN.md Phase 6: "revision history와 parent task
   * 연결"). Undefined for the first (revision 0) task of a session. Each
   * revision is written as an entirely new, immutable task bundle — the
   * parent's frames/marks/targets are never mutated in place.
   */
  parentTaskId: z.string().min(1).optional(),
  state: taskStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspace: z.object({ root: z.string().min(1) }),
  globalNote: z.string().optional(),
  frames: z.array(frameSchema),
  groups: z.array(instructionGroupSchema),
  references: z.array(referenceAssetSchema),
  marks: z.array(markSchema),
  targets: z.array(domTargetSchema),
}).superRefine((task, context) => {
  const addDuplicateIssues = (values: readonly { id: string }[], path: 'frames' | 'groups' | 'marks' | 'targets') => {
    const ids = new Set<string>();
    for (let index = 0; index < values.length; index++) {
      if (ids.has(values[index].id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [path, index, 'id'], message: `${path} IDs must be unique` });
      }
      ids.add(values[index].id);
    }
    return ids;
  };
  const frameIds = addDuplicateIssues(task.frames, 'frames');
  const groupIds = addDuplicateIssues(task.groups, 'groups');
  const markIds = addDuplicateIssues(task.marks, 'marks');
  const targetIds = addDuplicateIssues(task.targets, 'targets');

  const indexedGroupMarkIds = new Map<string, string>();
  const indexedGroupTargetIds = new Map<string, string>();
  for (let groupIndex = 0; groupIndex < task.groups.length; groupIndex++) {
    const group = task.groups[groupIndex];
    for (const markId of group.markIds) {
      if (!markIds.has(markId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', groupIndex, 'markIds'], message: `group mark is missing: ${markId}` });
      } else if (indexedGroupMarkIds.has(markId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', groupIndex, 'markIds'], message: `mark belongs to multiple groups: ${markId}` });
      }
      indexedGroupMarkIds.set(markId, group.id);
    }
    for (const targetId of group.targetIds) {
      if (!targetIds.has(targetId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', groupIndex, 'targetIds'], message: `group target is missing: ${targetId}` });
      } else if (indexedGroupTargetIds.has(`${group.id}:${targetId}`)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', groupIndex, 'targetIds'], message: `group target IDs must be unique: ${targetId}` });
      }
      const target = task.targets.find((candidate) => candidate.id === targetId);
      if (target && !target.groupIds.includes(group.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', groupIndex, 'targetIds'], message: `target groupIds disagree with group ownership: ${targetId}` });
      }
      indexedGroupTargetIds.set(`${group.id}:${targetId}`, group.id);
    }
  }
  for (let markIndex = 0; markIndex < task.marks.length; markIndex++) {
    const mark = task.marks[markIndex];
    if (!frameIds.has(mark.frameId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['marks', markIndex, 'frameId'], message: `mark frame is missing: ${mark.frameId}` });
    }
    if (!groupIds.has(mark.groupId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['marks', markIndex, 'groupId'], message: `mark group is missing: ${mark.groupId}` });
    }
    if (indexedGroupMarkIds.get(mark.id) !== mark.groupId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['marks', markIndex, 'groupId'], message: `group markIds disagree with mark ownership: ${mark.id}` });
    }
  }
  for (let targetIndex = 0; targetIndex < task.targets.length; targetIndex++) {
    const target = task.targets[targetIndex];
    if (!frameIds.has(target.frameId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['targets', targetIndex, 'frameId'], message: `target frame is missing: ${target.frameId}` });
    }
    for (const groupId of target.groupIds) {
      if (!groupIds.has(groupId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['targets', targetIndex, 'groupIds'], message: `target group is missing: ${groupId}` });
      }
      const group = task.groups.find((candidate) => candidate.id === groupId);
      if (!group?.targetIds.includes(target.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['targets', targetIndex, 'groupIds'], message: `group targetIds disagree with target ownership: ${target.id}` });
      }
    }
  }

  const referenceIds = new Set<string>();
  for (let index = 0; index < task.references.length; index++) {
    const id = task.references[index].id;
    if (referenceIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['references', index, 'id'], message: 'reference IDs must be unique' });
    }
    referenceIds.add(id);
  }
  const attachedIds = new Set<string>();
  for (let groupIndex = 0; groupIndex < task.groups.length; groupIndex++) {
    for (const id of task.groups[groupIndex].referenceIds) {
      attachedIds.add(id);
      if (!referenceIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', groupIndex, 'referenceIds'],
          message: `attached reference is missing from task references: ${id}`,
        });
      }
    }
  }
  for (let referenceIndex = 0; referenceIndex < task.references.length; referenceIndex++) {
    if (!attachedIds.has(task.references[referenceIndex].id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references', referenceIndex, 'id'],
        message: 'task reference must be attached to at least one group',
      });
    }
  }
});
export type VisualTask = z.infer<typeof visualTaskSchema>;
