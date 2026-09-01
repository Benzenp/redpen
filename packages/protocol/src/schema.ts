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

export const markSchema = z.discriminatedUnion('type', [
  freehandMarkSchema,
  arrowMarkSchema,
  rectangleMarkSchema,
  ellipseMarkSchema,
  textMarkSchema,
  maskMarkSchema,
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

export const visualTaskSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  state: taskStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspace: z.object({ root: z.string().min(1) }),
  globalNote: z.string().optional(),
  frames: z.array(frameSchema),
  groups: z.array(instructionGroupSchema),
  marks: z.array(markSchema),
  targets: z.array(domTargetSchema),
});
export type VisualTask = z.infer<typeof visualTaskSchema>;
