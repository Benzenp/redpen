/**
 * Draft reference-image staging storage. Images pasted or dropped into an
 * Instruction Group live here until submit copies the attached assets into
 * the immutable task bundle; session cleanup removes staging entries.
 *
 * Images are persisted without a database under
 * `<workspaceRoot>/.redpen/references/<id>.png`, with their metadata in
 * `index.json`.
 */
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redpenRootDir, assertSafeIdSegment } from './paths.js';
import { generateReferenceId } from './ids.js';

export interface ReferenceImageMeta {
  id: string;
  fileName: string;
  width: number;
  height: number;
  createdAt: string;
  label?: string;
}

export function referencesDir(workspaceRoot: string): string {
  return path.join(redpenRootDir(workspaceRoot), 'references');
}

export function referenceIndexPath(workspaceRoot: string): string {
  return path.join(referencesDir(workspaceRoot), 'index.json');
}

const saveQueues = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isSafeDirectory(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function resolveWorkspace(workspaceRoot: string): Promise<string> {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error('workspace root must be an absolute path');
  }

  const canonicalWorkspace = await realpath(workspaceRoot);
  const stats = await lstat(canonicalWorkspace);
  if (!isSafeDirectory(stats)) {
    throw new Error('workspace root must be an existing directory');
  }
  return canonicalWorkspace;
}

async function ensureSafeDirectory(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  try {
    const stats = await lstat(dir);
    if (!isSafeDirectory(stats)) {
      throw new Error(`refused unsafe reference storage component: ${dir}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      await mkdir(dir);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    const stats = await lstat(dir);
    if (!isSafeDirectory(stats)) {
      throw new Error(`refused unsafe reference storage component: ${dir}`);
    }
  }
  return dir;
}

async function existingReferencesDir(workspaceRoot: string): Promise<string | undefined> {
  const redpenDir = path.join(workspaceRoot, '.redpen');
  try {
    const redpenStats = await lstat(redpenDir);
    if (!isSafeDirectory(redpenStats)) {
      throw new Error(`refused unsafe reference storage component: ${redpenDir}`);
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }

  const dir = path.join(redpenDir, 'references');
  try {
    const stats = await lstat(dir);
    if (!isSafeDirectory(stats)) {
      throw new Error(`refused unsafe reference storage component: ${dir}`);
    }
    return dir;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function safeReferencesDir(workspaceRoot: string): Promise<string> {
  const redpenDir = await ensureSafeDirectory(workspaceRoot, '.redpen');
  return ensureSafeDirectory(redpenDir, 'references');
}

async function assertSafeRegularFile(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`refused unsafe reference storage file: ${filePath}`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function validateReferenceIndex(value: unknown): ReferenceImageMeta[] {
  if (!Array.isArray(value)) throw new Error('reference index must be an array');

  const ids = new Set<string>();
  return value.map((entry, position) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`reference index entry ${position} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const { id, fileName, width, height, createdAt, label } = candidate;
    if (typeof id !== 'string') throw new Error(`reference index entry ${position} has an invalid id`);
    assertSafeIdSegment(id);
    if (fileName !== `${id}.png`) {
      throw new Error(`reference index entry ${position} has an unsafe file name`);
    }
    if (
      typeof width !== 'number' ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new Error(`reference index entry ${position} has invalid dimensions`);
    }
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error(`reference index entry ${position} has an invalid creation time`);
    }
    if (label !== undefined && typeof label !== 'string') {
      throw new Error(`reference index entry ${position} has an invalid label`);
    }
    if (ids.has(id)) throw new Error(`reference index contains duplicate id: ${id}`);
    ids.add(id);
    return label === undefined ? { id, fileName, width, height, createdAt } : { id, fileName, width, height, createdAt, label };
  });
}

async function readReferenceIndex(dir: string): Promise<ReferenceImageMeta[]> {
  const indexPath = path.join(dir, 'index.json');
  try {
    if (!await assertSafeRegularFile(indexPath)) return [];
    const contents = await readFile(indexPath, 'utf8');
    return validateReferenceIndex(JSON.parse(contents) as unknown);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function writeAtomically(destination: string, contents: string | Buffer): Promise<void> {
  await assertSafeRegularFile(destination);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    if (typeof contents === 'string') {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } else {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function saveInWorkspace(
  workspaceRoot: string,
  pngBuffer: Buffer,
  meta: { width: number; height: number; label?: string },
): Promise<ReferenceImageMeta> {
  const dir = await safeReferencesDir(workspaceRoot);
  const index = await readReferenceIndex(dir);
  if (!Number.isSafeInteger(meta.width) || meta.width <= 0 || !Number.isSafeInteger(meta.height) || meta.height <= 0) {
    throw new Error('reference dimensions must be positive safe integers');
  }
  if (meta.label !== undefined && typeof meta.label !== 'string') throw new Error('reference label must be a string');

  const id = generateReferenceId();
  assertSafeIdSegment(id);
  const fileName = `${id}.png`;
  const imagePath = path.join(dir, fileName);
  if (await assertSafeRegularFile(imagePath)) throw new Error(`reference image already exists: ${fileName}`);

  const reference: ReferenceImageMeta = {
    id,
    fileName,
    width: meta.width,
    height: meta.height,
    createdAt: new Date().toISOString(),
    ...(meta.label === undefined ? {} : { label: meta.label }),
  };

  await writeAtomically(imagePath, pngBuffer);
  try {
    await writeAtomically(path.join(dir, 'index.json'), JSON.stringify([...index, reference], null, 2));
  } catch (error) {
    await rm(imagePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return reference;
}

export async function saveReferenceImage(
  workspaceRoot: string,
  pngBuffer: Buffer,
  meta: { width: number; height: number; label?: string },
): Promise<ReferenceImageMeta> {
  const canonicalWorkspace = await resolveWorkspace(workspaceRoot);
  const previous = saveQueues.get(canonicalWorkspace) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => saveInWorkspace(canonicalWorkspace, pngBuffer, meta));
  const queued = current.then(() => undefined, () => undefined);
  saveQueues.set(canonicalWorkspace, queued);
  try {
    return await current;
  } finally {
    if (saveQueues.get(canonicalWorkspace) === queued) saveQueues.delete(canonicalWorkspace);
  }
}

export async function listReferenceImages(workspaceRoot: string): Promise<ReferenceImageMeta[]> {
  const canonicalWorkspace = await resolveWorkspace(workspaceRoot);
  const dir = await existingReferencesDir(canonicalWorkspace);
  return dir === undefined ? [] : readReferenceIndex(dir);
}

export async function readReferenceImage(workspaceRoot: string, id: string): Promise<Buffer> {
  assertSafeIdSegment(id);
  const canonicalWorkspace = await resolveWorkspace(workspaceRoot);
  const dir = await existingReferencesDir(canonicalWorkspace);
  if (dir === undefined) throw new Error('reference directory does not exist');
  const imagePath = path.join(dir, `${id}.png`);
  if (!await assertSafeRegularFile(imagePath)) throw new Error('reference image does not exist');
  return readFile(imagePath);
}

async function deleteInWorkspace(workspaceRoot: string, id: string): Promise<void> {
  assertSafeIdSegment(id);
  const dir = await existingReferencesDir(workspaceRoot);
  if (dir === undefined) return;
  const index = await readReferenceIndex(dir);
  const reference = index.find((entry) => entry.id === id);
  if (!reference) return;
  const imagePath = path.join(dir, reference.fileName);
  if (!await assertSafeRegularFile(imagePath)) {
    await writeAtomically(
      path.join(dir, 'index.json'),
      JSON.stringify(index.filter((entry) => entry.id !== id), null, 2),
    );
    return;
  }
  const imageContents = await readFile(imagePath);
  await rm(imagePath, { force: true });
  try {
    await writeAtomically(
      path.join(dir, 'index.json'),
      JSON.stringify(index.filter((entry) => entry.id !== id), null, 2),
    );
  } catch (error) {
    await writeAtomically(imagePath, imageContents).catch(() => undefined);
    throw error;
  }
}

export async function deleteReferenceImage(workspaceRoot: string, id: string): Promise<void> {
  const canonicalWorkspace = await resolveWorkspace(workspaceRoot);
  const previous = saveQueues.get(canonicalWorkspace) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => deleteInWorkspace(canonicalWorkspace, id));
  const queued = current.then(() => undefined, () => undefined);
  saveQueues.set(canonicalWorkspace, queued);
  try {
    await current;
  } finally {
    if (saveQueues.get(canonicalWorkspace) === queued) saveQueues.delete(canonicalWorkspace);
  }
}
