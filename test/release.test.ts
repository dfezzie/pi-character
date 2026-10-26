import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import pty from 'node-pty';

async function release(args: string[], failBuild = false, interactive = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-release-test-'));
  const log = join(directory, 'calls.jsonl');
  const executable = join(directory, 'npm');
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args) + '\\n');
if (process.env.RELEASE_TEST_FAIL === '1' && args[0] === 'run') process.exit(1);
if (args[0] === 'pack') console.log(JSON.stringify([{
  name: 'pi-character', version: '0.1.0', filename: 'pi-character-0.1.0.tgz',
  size: 100, files: [{ path: 'README.md' }]
}]));
`,
    );
    await chmod(executable, 0o755);
    const env = {
      ...process.env,
      PATH: directory + delimiter + process.env.PATH,
      RELEASE_TEST_LOG: log,
      RELEASE_TEST_FAIL: failBuild ? '1' : '0',
      npm_config_registry: 'https://registry.example.invalid/',
    };
    const argv = ['scripts/update-npm.ts', ...args];
    const result = interactive
      ? await new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
          const child = pty.spawn(process.execPath, argv, {
            cwd: process.cwd(),
            env,
            name: 'xterm-256color',
            cols: 100,
            rows: 30,
          });
          let output = '';
          let answered = false;
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Release confirmation test timed out'));
          }, 10000);
          child.onData((data) => {
            output += data;
            if (!answered && output.includes('[y/N]')) {
              answered = true;
              child.write('yes\r');
            }
          });
          child.onExit(({ exitCode }) => {
            clearTimeout(timer);
            resolve({ status: exitCode, stdout: output, stderr: output });
          });
        })
      : spawnSync(process.execPath, argv, { encoding: 'utf8', env });
    const calls = await readFile(log, 'utf8').catch(() => '');
    return {
      ...result,
      calls: calls.trim()
        ? calls
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('release preview runs checks but never bumps or performs a real publish', async () => {
  const result = await release(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((args: string[]) => args[0]),
    ['run', 'pack', 'publish'],
  );
  assert.ok(result.calls[2].includes('--dry-run'));
  assert.ok(result.calls[2].includes('--access'));
  assert.equal(
    result.calls[2][result.calls[2].indexOf('--registry') + 1],
    'https://registry.npmjs.org/',
  );
  assert.match(result.stdout, /No version changes or publication/);
});

test('failed release checks prevent packing, version changes, and publishing', async () => {
  const result = await release(['--dry-run'], true);
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [['run', 'build']]);
});

test('noninteractive release refuses publication before running any npm commands', async () => {
  const result = await release([]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /interactive terminal/);
});

test('invalid release options run no npm commands', async () => {
  for (const args of [['--yes'], ['--current', 'patch'], ['minor', 'major']]) {
    const result = await release(args);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  }
});

// A fake npm runs inside a real PTY: no credentials, version bump, network, or upload.
test('confirmed release pins npmjs despite inherited registry and publishes the previewed archive', async () => {
  const result = await release(['--current'], false, true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((args: string[]) => args[0]),
    ['run', 'whoami', 'pack', 'publish', 'publish'],
  );
  for (const call of [result.calls[1], result.calls[3], result.calls[4]]) {
    assert.equal(call[call.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
  }
  assert.ok(result.calls[3].includes('--dry-run'));
  assert.ok(!result.calls[4].includes('--dry-run'));
  assert.equal(result.calls[3][1], result.calls[4][1]);
  assert.match(result.stdout, /Published pi-character@0.1.0/);
});
