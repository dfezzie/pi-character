import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { command, isolatedConfig, options, ROOT, Terminal } from './smoke.ts';
import { generationError, GenerationStopped } from '../src/generation.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-character-harness-'));
  const config = join(directory, 'agent');
  await mkdir(config);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    config,
    terminal: async (code: string) => {
      const terminal = await Terminal.create(
        [process.execPath, '-e', code],
        config,
        directory,
        directory,
      );
      t.after(() => terminal.close());
      return terminal;
    },
  };
}

test('smoke model override stays request scoped and generation requires an explicit flag', () => {
  const args = options(['--model', 'provider/test-model']);
  assert.ok(!command(args).includes('-e'));
  assert.ok(!command(args).includes('--model'));
  assert.equal(args.generate, false);
  assert.ok(command({ ...args, source: true }).includes('-e'));
  assert.throws(() => options(['--startup-timeout', 'NaN']), /positive/);
});

test('smoke config loads only this package and leaves source settings untouched', async (t) => {
  const { directory, config } = await fixture(t);
  const source = join(directory, 'original');
  await mkdir(source);
  const original = JSON.stringify({
    packages: [relative(source, ROOT)],
    defaultModel: 'untouched',
    extensions: ['other'],
    mcpServers: { other: {} },
  });
  await writeFile(join(source, 'settings.json'), original);
  await writeFile(join(source, 'auth.json'), 'secret');
  await isolatedConfig(source, config);
  assert.deepEqual(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')), {
    packages: [ROOT],
  });
  await assert.rejects(readFile(join(config, 'auth.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), original);
  await isolatedConfig(source, config, { generate: true });
  assert.equal(await readFile(join(config, 'auth.json'), 'utf8'), 'secret');
  assert.equal(
    JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')).defaultModel,
    'untouched',
  );
});

test('smoke missing install fails; source mode needs no existing config', async (t) => {
  const { directory, config } = await fixture(t);
  await assert.rejects(isolatedConfig(directory, config), /not installed/);
  await isolatedConfig(join(directory, 'missing'), config, { source: true });
  assert.deepEqual(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')), {
    packages: [],
  });
});

test('smoke provider error fails promptly through a real PTY', async (t) => {
  const f = await fixture(t);
  const terminal = await f.terminal(
    "console.log('Error: Character: Error: model_not_found'); setInterval(() => {}, 1000)",
  );
  const started = performance.now();
  await assert.rejects(
    terminal.wait(() => false, 'generation', 20000),
    /reported an error/,
  );
  assert.ok(performance.now() - started < 2000);
});

test('smoke recognizes actual generation helper failures', async (t) => {
  const f = await fixture(t);
  const errors = [
    'model_not_found',
    '401 auth',
    '429 quota',
    'max_tokens',
    'Invalid character fields',
    'connection failed',
  ].map((message) => new Error(message));
  errors.push(
    new GenerationStopped('cancelled'),
    new GenerationStopped('timed out after two minutes'),
  );
  for (const error of errors) {
    const message = generationError(error, { provider: 'fixture', id: 'offline' });
    const terminal = await f.terminal(
      `console.log(${JSON.stringify(message)}); setInterval(() => {}, 1000)`,
    );
    try {
      await assert.rejects(
        terminal.wait(() => false, 'generation', 2000),
        /reported an error/,
      );
    } finally {
      await terminal.close();
    }
  }
});

test('smoke child exit fails promptly', async (t) => {
  const f = await fixture(t);
  const terminal = await f.terminal("console.log('startup failed'); process.exitCode = 7");
  const started = performance.now();
  await assert.rejects(
    terminal.wait(() => false, 'startup', 20000),
    /exited with status 7/,
  );
  assert.ok(performance.now() - started < 2000);
});

test('smoke observes rendered screen, answers terminal queries, and times out', async (t) => {
  const f = await fixture(t);
  const terminal = await f.terminal(
    "process.stdin.setRawMode(true); process.stdin.on('data', () => console.log('query answered')); process.stdout.write('\\x1b]11;?\\x07'); console.log('Created Moon. Cached for local replay.')",
  );
  await terminal.wait(
    () => terminal.observed.includes('Created Moon') && terminal.text().includes('query answered'),
    'result',
    2000,
  );
  await assert.rejects(
    terminal.wait(() => false, 'never appears', 50),
    /Timed out: never appears/,
  );
});

test('smoke shutdown escalates, reaps the child, and is idempotent', async (t) => {
  const f = await fixture(t);
  const terminal = await f.terminal(
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
  );
  await terminal.wait(() => terminal.observed.includes('ready'), 'ready', 2000);
  await terminal.close();
  await terminal.close();
  assert.ok(terminal.exited);
  assert.ok(terminal.exited.signal || terminal.exited.exitCode !== 0);
  assert.throws(() => process.kill(terminal.proc.pid, 0), { code: 'ESRCH' });
});
