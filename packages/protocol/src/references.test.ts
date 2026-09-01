import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteReferenceImage,
  listReferenceImages,
  readReferenceImage,
  referenceIndexPath,
  referencesDir,
  saveReferenceImage,
} from './references.js';

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'redpen-references-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('saveReferenceImage lists metadata and preserves the original PNG bytes', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    const saved = await saveReferenceImage(workspaceRoot, png, { width: 3, height: 4, label: 'example' });

    assert.equal(saved.fileName, `${saved.id}.png`);
    assert.equal(saved.width, 3);
    assert.equal(saved.height, 4);
    assert.equal(saved.label, 'example');
    assert.deepEqual(await listReferenceImages(workspaceRoot), [saved]);
    assert.deepEqual(await readReferenceImage(workspaceRoot, saved.id), png);
  });
});

test('saving multiple references accumulates all entries in index.json', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const first = await saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 2 });
    const second = await saveReferenceImage(workspaceRoot, Buffer.from([2]), { width: 5, height: 6, label: 'second' });

    assert.deepEqual(await listReferenceImages(workspaceRoot), [first, second]);
    const index = JSON.parse(await readFile(referenceIndexPath(workspaceRoot), 'utf8')) as unknown;
    assert.deepEqual(index, [first, second]);
  });
});

test('deleteReferenceImage removes both metadata and PNG bytes', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const first = await saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 });
    const second = await saveReferenceImage(workspaceRoot, Buffer.from([2]), { width: 2, height: 2 });

    await deleteReferenceImage(workspaceRoot, first.id);

    assert.deepEqual(await listReferenceImages(workspaceRoot), [second]);
    await assert.rejects(readReferenceImage(workspaceRoot, first.id), /does not exist/);
    assert.deepEqual(await readReferenceImage(workspaceRoot, second.id), Buffer.from([2]));
  });
});

test('deleteReferenceImage reconciles stale metadata when the PNG is already missing', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const saved = await saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 });
    await rm(path.join(referencesDir(workspaceRoot), saved.fileName));

    await deleteReferenceImage(workspaceRoot, saved.id);

    assert.deepEqual(await listReferenceImages(workspaceRoot), []);
  });
});

test('concurrent saves retain every reference entry', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const saved = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        saveReferenceImage(workspaceRoot, Buffer.from([index]), { width: index + 1, height: index + 1 }),
      ),
    );

    const listed = await listReferenceImages(workspaceRoot);
    assert.equal(listed.length, saved.length);
    assert.deepEqual(new Set(listed.map((reference) => reference.id)), new Set(saved.map((reference) => reference.id)));
  });
});

test('rejects corrupt or unsafe reference index entries', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const indexPath = referenceIndexPath(workspaceRoot);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify([{
      id: 'safe-id',
      fileName: '../outside.png',
      width: 1,
      height: 1,
      createdAt: new Date().toISOString(),
    }]));

    await assert.rejects(listReferenceImages(workspaceRoot), /unsafe file name/);
    await assert.rejects(saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 }), /unsafe file name/);
  });
});

test('rejects traversal in reference image identifiers', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(readReferenceImage(workspaceRoot, '../outside'), /refused to resolve path outside allowed root/);
  });
});

test('requires an absolute existing workspace directory', async () => {
  await assert.rejects(saveReferenceImage('relative-workspace', Buffer.from([1]), { width: 1, height: 1 }), /absolute path/);
  await assert.rejects(
    saveReferenceImage(path.join(os.tmpdir(), `redpen-missing-${Date.now()}`), Buffer.from([1]), { width: 1, height: 1 }),
    /ENOENT/,
  );
});

test('rejects symlinked reference components and image files where symlinks are supported', async (t) => {
  await withTempWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'redpen-references-outside-'));
    try {
      try {
        await symlink(outside, path.join(workspaceRoot, '.redpen'), 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
          t.skip('symlink creation is unavailable');
          return;
        }
        throw error;
      }
      await assert.rejects(saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 }), /unsafe reference storage component/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await withTempWorkspace(async (workspaceRoot) => {
    const outside = path.join(workspaceRoot, 'outside.png');
    const imagePath = path.join(workspaceRoot, '.redpen', 'references', 'safe-id.png');
    const indexPath = referenceIndexPath(workspaceRoot);
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(outside, 'outside');
    try {
      await symlink(outside, imagePath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
        t.skip('symlink creation is unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(readReferenceImage(workspaceRoot, 'safe-id'), /unsafe reference storage file/);

    await symlink(outside, indexPath, 'file');
    await assert.rejects(saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 }), /unsafe reference storage file/);
  });
});

test('writes an atomically replaceable index without temporary files', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const first = await saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 });
    const second = await saveReferenceImage(workspaceRoot, Buffer.from([2]), { width: 2, height: 2 });
    const indexPath = referenceIndexPath(workspaceRoot);

    assert.deepEqual(JSON.parse(await readFile(indexPath, 'utf8')), [first, second]);
    assert.deepEqual((await readdir(path.dirname(indexPath))).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('removes a new PNG when index persistence fails', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const indexPath = referenceIndexPath(workspaceRoot);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await mkdir(indexPath);

    await assert.rejects(saveReferenceImage(workspaceRoot, Buffer.from([1]), { width: 1, height: 1 }), /unsafe reference storage file/);
    assert.deepEqual((await readdir(path.dirname(indexPath))).filter((name) => name.endsWith('.png')), []);
  });
});
