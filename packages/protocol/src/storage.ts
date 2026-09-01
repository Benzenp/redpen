/**
 * Atomic task bundle writer (docs/ARCHITECTURE.md §2.4, §7).
 *
 * Write sequence:
 * 1. Write every file (task.json, task.md, frame assets, checksums.json)
 *    into `.tmp-<task-id>/`.
 * 2. Validate the schema and compute checksums before anything is exposed.
 * 3. Atomically rename `.tmp-<task-id>/` to the final `<task-id>/` directory.
 * 4. Update `.redpen/latest.json` last, once the bundle is fully in place.
 *
 * A crash or interruption between steps 1-3 leaves only a `.tmp-*` directory
 * behind, which readers must ignore — it never becomes a visible task.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { visualTaskSchema, type VisualTask } from './schema.js';
import { taskDir, tasksDir, taskTmpDir, latestPointerPath, redpenRootDir, assertSafeIdSegment } from './paths.js';

export interface BundleFile {
  /** Path relative to the task directory root, e.g. "frames/frame-001/source.png". */
  relativePath: string;
  content: Buffer | string;
}

export interface LatestPointer {
  taskId: string;
  path: string;
  submittedAt: string;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toHumanSummary(task: VisualTask): string {
  const lines: string[] = [];
  lines.push(`# Redpen task ${task.id}`);
  lines.push('');
  lines.push(`- session: ${task.sessionId}`);
  lines.push(`- revision: ${task.revision}`);
  lines.push(`- state: ${task.state}`);
  if (task.globalNote) {
    lines.push('');
    lines.push(`## Global note`);
    lines.push(task.globalNote);
  }
  lines.push('');
  lines.push(`## Instruction groups (${task.groups.length})`);
  for (const group of task.groups) {
    lines.push('');
    lines.push(`### #${group.number} (${group.color})`);
    if (group.note) lines.push(group.note);
    lines.push(`- marks: ${group.markIds.length}`);
    lines.push(`- dom targets: ${group.targetIds.length}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Writes a full task bundle atomically. Throws (and leaves no visible final
 * directory) if validation fails or the write is interrupted.
 */
export async function writeTaskBundle(
  workspaceRoot: string,
  task: VisualTask,
  extraFiles: BundleFile[] = [],
): Promise<{ finalDir: string; checksums: Record<string, string> }> {
  const validated = visualTaskSchema.parse(task);
  assertSafeIdSegment(validated.id);

  await mkdir(tasksDir(workspaceRoot), { recursive: true });

  const tmpDir = taskTmpDir(workspaceRoot, validated.id);
  const finalDir = taskDir(workspaceRoot, validated.id);

  // Clean up any stale tmp dir from a prior interrupted attempt before starting.
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    const taskJson = JSON.stringify(validated, null, 2);
    const taskMd = toHumanSummary(validated);

    const allFiles: BundleFile[] = [
      { relativePath: 'task.json', content: taskJson },
      { relativePath: 'task.md', content: taskMd },
      ...extraFiles,
    ];

    const checksums: Record<string, string> = {};
    for (const file of allFiles) {
      const target = path.join(tmpDir, file.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      checksums[file.relativePath] = sha256(file.content);
    }

    await writeFile(path.join(tmpDir, 'checksums.json'), JSON.stringify(checksums, null, 2));

    // Final validation pass: read back task.json exactly as a consumer would.
    const roundTrip = JSON.parse(await readFile(path.join(tmpDir, 'task.json'), 'utf8'));
    visualTaskSchema.parse(roundTrip);

    // Atomic rename: this is the single moment the task becomes visible.
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  await mkdir(redpenRootDir(workspaceRoot), { recursive: true });
  const latest: LatestPointer = {
    taskId: validated.id,
    path: finalDir,
    submittedAt: new Date().toISOString(),
  };
  await writeFile(latestPointerPath(workspaceRoot), JSON.stringify(latest, null, 2));

  const checksums = JSON.parse(await readFile(path.join(finalDir, 'checksums.json'), 'utf8'));
  return { finalDir, checksums };
}

/** Lists task IDs that have a fully committed (non-tmp) bundle directory. */
export async function listTaskIds(workspaceRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tasksDir(workspaceRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((name) => !name.startsWith('.tmp-'));
}

export async function readTaskBundle(workspaceRoot: string, taskId: string): Promise<VisualTask> {
  const dir = taskDir(workspaceRoot, taskId);
  const raw = await readFile(path.join(dir, 'task.json'), 'utf8');
  return visualTaskSchema.parse(JSON.parse(raw));
}

export async function readLatestPointer(workspaceRoot: string): Promise<LatestPointer | null> {
  try {
    const raw = await readFile(latestPointerPath(workspaceRoot), 'utf8');
    return JSON.parse(raw) as LatestPointer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
