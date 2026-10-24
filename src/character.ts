import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export const PALETTE = { cyan: 81, orange: 215, green: 114, pink: 212, blue: 111, yellow: 222 };
export type Sprite = {
  name: string;
  color: keyof typeof PALETTE;
  frame_ms: number;
  frames: string[][];
};
export type CharacterSettings = {
  enabled: boolean;
  selected?: string;
  color?: string;
  deleted?: string[];
};
export type CharacterAsset = { id: string; sprite: Sprite; description?: string; model?: string };
const MAX_BYTES = 65536;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const dense = (a: unknown): a is unknown[] =>
  Array.isArray(a) &&
  Object.keys(a).length === a.length &&
  Object.keys(a).every((key, i) => key === String(i));
const printable = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.length <= max && /^[\x20-\x7e]*$/.test(s);
export function validate(value: unknown): Sprite {
  const s = record(value) ? (value.sprite ?? value) : value;
  if (!record(s) || Object.keys(s).sort().join(',') !== 'color,frame_ms,frames,name')
    throw new Error('Invalid character fields');
  if (
    !printable(s.name, 40) ||
    !s.name.trim() ||
    typeof s.color !== 'string' ||
    !Object.hasOwn(PALETTE, s.color)
  )
    throw new Error('Invalid name or palette');
  if (
    typeof s.frame_ms !== 'number' ||
    !Number.isInteger(s.frame_ms) ||
    s.frame_ms < 80 ||
    s.frame_ms > 600
  )
    throw new Error('Frame timing must be 80–600 ms');
  if (!dense(s.frames) || s.frames.length < 4 || s.frames.length > 12)
    throw new Error('Expected 4–12 frames');
  const height = Array.isArray(s.frames[0]) ? s.frames[0].length : 0;
  if (
    height < 4 ||
    height > 14 ||
    s.frames.some(
      (f) =>
        !dense(f) ||
        f.length !== height ||
        f.some((row) => !printable(row, 36)) ||
        !f.some((row) => typeof row === 'string' && row.trim()),
    )
  )
    throw new Error('Invalid frame dimensions or non-ASCII artwork');
  if (new Set(s.frames.map((f) => JSON.stringify(f))).size < 2)
    throw new Error('Character needs at least two distinct poses');
  return s as Sprite;
}
async function readJson(path: string): Promise<unknown> {
  // Nonblocking open lets us reject FIFOs without waiting for a writer.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Character must be a regular file');
    if (stat.size > MAX_BYTES) throw new Error('Character exceeds 64 KiB');
    const data = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('Character exceeds 64 KiB');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size)));
  } finally {
    await handle.close();
  }
}
export async function readAsset(path: string) {
  return validate(await readJson(path));
}
export function parseGenerated(text: unknown) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES)
    throw new Error('Character exceeds 64 KiB');
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return validate(JSON.parse(trimmed));
}
export function frameLines(
  sprite: Sprite,
  elapsed: number,
  width: number,
  color: boolean | ((text: string) => string) = true,
) {
  const artWidth = Math.max(...sprite.frames.flat().map((row) => row.length));
  if (width < Math.max(artWidth, sprite.name.length) + 2) return [];
  const index = Math.floor(Math.max(0, elapsed) / sprite.frame_ms) % sprite.frames.length;
  const indent = ' '.repeat(Math.floor((width - artWidth) / 2));
  const paint =
    typeof color === 'function'
      ? color
      : color
        ? (text: string) => `\x1b[38;5;${PALETTE[sprite.color]}m${text}\x1b[0m`
        : (text: string) => text;
  const caption = ' '.repeat(Math.floor((width - sprite.name.length) / 2)) + paint(sprite.name);
  return [
    '',
    ...sprite.frames[index].map((row) => indent + paint(row.padEnd(artWidth))),
    '',
    caption,
    '',
  ];
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error('Expected a JSON value');
  const data = serialized + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Character exceeds 64 KiB');
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function saveAsset(
  directory: string,
  value: unknown,
  description: string,
  model: string,
  usage?: unknown,
) {
  const sprite = validate(value);
  await mkdir(directory, { recursive: true });
  const id = createHash('sha256').update(JSON.stringify(sprite)).digest('hex').slice(0, 20);
  await atomicJson(join(directory, `${id}.json`), {
    version: 1,
    description,
    model,
    usage,
    sprite,
  });
  return id;
}
export async function deleteAsset(directory: string, id: string) {
  if (!/^[a-f0-9]{20}$/.test(id)) throw new Error('Invalid character ID');
  // Keep deletion reversible without exposing archived characters in the picker.
  await mkdir(join(directory, '.trash'), { recursive: true });
  await rename(join(directory, `${id}.json`), join(directory, '.trash', `${id}.json`));
}
export async function listAssets(directory: string): Promise<CharacterAsset[]> {
  await mkdir(directory, { recursive: true });
  const result: CharacterAsset[] = [];
  for (const name of (await readdir(directory)).filter((n) => /^[a-f0-9]{20}\.json$/.test(n))) {
    try {
      const asset = await readJson(join(directory, name));
      if (!record(asset)) continue;
      result.push({
        id: name.slice(0, -5),
        sprite: validate(asset),
        description: typeof asset.description === 'string' ? asset.description : undefined,
        model: typeof asset.model === 'string' ? asset.model : undefined,
      });
    } catch {
      /* A malformed user asset must not break the picker or startup. */
    }
  }
  return result.sort((a, b) => a.sprite.name.localeCompare(b.sprite.name));
}
export async function readSettings(directory: string): Promise<CharacterSettings> {
  try {
    const s = await readJson(join(directory, 'settings.json'));
    if (!record(s)) return { enabled: true };
    const color =
      typeof s.color === 'string' &&
      ['default', 'original', ...Object.keys(PALETTE)].includes(s.color)
        ? { color: s.color }
        : {};
    const deleted = Array.isArray(s.deleted)
      ? { deleted: s.deleted.filter((id) => typeof id === 'string' && /^[a-f0-9]{20}$/.test(id)) }
      : {};
    return {
      enabled: s.enabled !== false,
      selected:
        typeof s.selected === 'string' && /^[a-f0-9]{20}$/.test(s.selected)
          ? s.selected
          : undefined,
      ...color,
      ...deleted,
    };
  } catch {
    return { enabled: true };
  }
}
