import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Sprite,
  readAsset,
  validate,
  frameLines,
  saveAsset,
  listAssets,
  parseGenerated,
  readSettings,
} from '../src/character.ts';
const assetPath = fileURLToPath(new URL('../assets/cray.json', import.meta.url));
const fixture = () => readAsset(assetPath);

test('rejects terminal escapes, invalid timing, oversized and static artwork', async () => {
  const base = await fixture();
  for (const change of [
    (s: Sprite) => (s.frames[0][0] = '\x1b[2J'),
    (s: Sprite) => (s.frames[0][0] = '🦊'),
    (s: Sprite) => (s.frames[0][0] = 'x'.repeat(37)),
    (s: Sprite) => (s.frame_ms = 0),
    (s: Sprite) => (s.frames = Array(6).fill(s.frames[0])),
    (s: Sprite) => s.frames[0].push('extra'),
  ]) {
    const sprite = structuredClone(base);
    change(sprite);
    assert.throws(() => validate(sprite));
  }
});
test('renders distinct poses, loops, and fits terminal columns', async () => {
  const sprite = await fixture();
  const first = frameLines(sprite, 0, 60, false);
  assert.deepEqual(first, frameLines(sprite, sprite.frame_ms * sprite.frames.length, 60, false));
  assert.ok(
    sprite.frames.some(
      (_, i) =>
        JSON.stringify(frameLines(sprite, i * sprite.frame_ms, 60, false)) !==
        JSON.stringify(first),
    ),
  );
  assert.ok(first.every((line) => line.length <= 60));
  assert.deepEqual(frameLines(sprite, 0, 3), []);
  const themed = frameLines(sprite, 0, 60, (text) => `<accent>${text}</accent>`);
  assert.ok(themed.some((line) => line.includes(`<accent>${sprite.name}</accent>`)));
  assert.ok(themed[1].includes('<accent>'));
});
test('round trips assets, deduplicates, skips broken files, and sanitizes selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-character-test-'));
  try {
    const sprite = await fixture();
    const id = await saveAsset(dir, sprite, 'test', 'fixture');
    assert.equal(id, await saveAsset(dir, sprite, 'test', 'fixture'));
    await writeFile(join(dir, 'a'.repeat(20) + '.json'), 'invalid');
    assert.equal((await listAssets(dir)).length, 1);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ selected: '../../secret', enabled: false }),
    );
    assert.deepEqual(await readSettings(dir), { enabled: false, selected: undefined });
    await writeFile(join(dir, 'large.json'), 'x'.repeat(65537));
    await assert.rejects(readAsset(join(dir, 'large.json')), /64 KiB/);
    assert.deepEqual(parseGenerated('```json\n' + JSON.stringify(sprite) + '\n```'), sprite);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects malformed and sparse frame structures', async () => {
  const base = await fixture();
  for (const frames of [
    Array(4),
    [null, ...base.frames.slice(1)],
    ['abcd', ...base.frames.slice(1)],
    base.frames.map(() => Array(4)),
    base.frames.map(() => []),
    base.frames.map(() => [' ', ' ', ' ', ' ']),
  ]) {
    assert.throws(() => validate({ ...base, frames }));
  }
  const sparse = structuredClone(base);
  delete sparse.frames[1][1];
  assert.throws(() => validate(sparse));
  for (const bad of [
    null,
    false,
    4,
    [],
    {},
    { sprite: null },
    { ...base, extra: 1 },
    { ...base, color: '__proto__' },
    { ...base, color: ['cyan'] },
    { ...base, frame_ms: NaN },
  ]) {
    assert.throws(() => validate(bad));
  }
});

test('bounded reads reject directories, invalid UTF-8 and oversized generated data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-character-read-'));
  try {
    await assert.rejects(readAsset(dir), /regular file/);
    const sprite = await fixture();
    const valid = JSON.stringify(sprite);
    await writeFile(join(dir, 'edge.json'), valid.padEnd(65536));
    assert.deepEqual(await readAsset(join(dir, 'edge.json')), sprite);
    await writeFile(join(dir, 'edge.json'), valid.padEnd(65537));
    await assert.rejects(readAsset(join(dir, 'edge.json')), /64 KiB/);
    await writeFile(join(dir, 'bad.json'), Buffer.from([0xff]));
    await assert.rejects(readAsset(join(dir, 'bad.json')));
    assert.throws(() => parseGenerated(valid.padEnd(65537)), /64 KiB/);
    assert.throws(() => parseGenerated(undefined));
    await writeFile(join(dir, 'settings.json'), ' '.repeat(65537));
    assert.deepEqual(await readSettings(dir), { enabled: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomic storage preserves destination and removes temporary files on failure', async () => {
  const { atomicJson } = await import('../src/character.ts');
  const { mkdir, readFile, readdir, stat } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'pi-character-atomic-'));
  try {
    const target = join(dir, 'settings.json');
    await atomicJson(target, { enabled: false });
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(atomicJson(target, { huge: 'x'.repeat(65536) }), /64 KiB/);
    await assert.rejects(atomicJson(target, undefined), /JSON value/);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    await assert.rejects(atomicJson(target, cycle));
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { enabled: false });
    const blocked = join(dir, 'directory.json');
    await mkdir(blocked);
    await assert.rejects(atomicJson(blocked, { enabled: true }));
    assert.deepEqual((await readdir(dir)).sort(), ['directory.json', 'settings.json']);
    const sprite = await fixture();
    await assert.rejects(saveAsset(dir, sprite, 'x'.repeat(65536), 'fixture'), /64 KiB/);
    assert.deepEqual((await readdir(dir)).sort(), ['directory.json', 'settings.json']);
    const id = await saveAsset(dir, { sprite }, 'wrapped', 'fixture');
    assert.deepEqual(await readAsset(join(dir, id + '.json')), sprite);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'non-file FIFO imports fail without blocking',
  { skip: process.platform === 'win32' },
  async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'pi-character-fifo-'));
    try {
      const path = join(dir, 'pipe.json');
      execFileSync('mkfifo', [path]);
      await assert.rejects(readAsset(path), /regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
