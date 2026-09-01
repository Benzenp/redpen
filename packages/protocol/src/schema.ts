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
