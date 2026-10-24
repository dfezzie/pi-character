// Real Pi terminal checks. Generation is opt-in and may spend provider tokens.
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { readAsset } from '../src/character.ts';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ERROR =
  /unavailable\s+or\s+unsupported|Authentication\s+or\s+access\s+failed|Rate\s+limit\s+or\s+quota\s+reached|Generation\s+(?:failed\s+with|cancelled|timed\s+out)|Existing\s+character\s+kept|Character:\s*[A-Za-z]*Error|Error:\s*Character:|model_not_found|Failed to load extension|Duplicate.*character/i;
const expandHome = (path: string) =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
async function readJson(
  path: string,
  fallback?: Record<string, any>,
): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined)
      return fallback;
    throw error;
  }
}

export function options(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      pi: { type: 'string', default: 'pi' },
      config: {
        type: 'string',
        default: process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'),
      },
      source: { type: 'boolean', default: false },
      generate: { type: 'boolean', default: false },
      model: { type: 'string' },
      description: { type: 'string', default: 'a tiny smiling moon wearing headphones' },
      'startup-timeout': { type: 'string', default: '15' },
      'generation-timeout': { type: 'string', default: '130' },
      output: { type: 'string' },
    },
  });
  const timeout = (key: 'startup-timeout' | 'generation-timeout') => {
    const milliseconds = Number(values[key]) * 1000;
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
      throw new Error(`${key} must be positive seconds`);
    return milliseconds;
  };
  return {
    ...values,
    'startup-timeout': timeout('startup-timeout'),
    'generation-timeout': timeout('generation-timeout'),
  };
}
type SmokeOptions = ReturnType<typeof options>;

export function command(args: SmokeOptions) {
  return [
    args.pi,
    '--no-session',
    '--no-mcp',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-approve',
    '--offline',
    ...(args.source ? ['--no-extensions', '-e', ROOT] : []),
  ];
}

export async function isolatedConfig(
  source: string,
  destination: string,
  { source: sourceMode = false, generate = false } = {},
) {
  source = resolve(expandHome(source));
  const original = await readJson(join(source, 'settings.json'), {});
  const installed = (original.packages || []).filter((entry: string | { source?: string }) => {
    const path = typeof entry === 'string' ? entry : entry.source;
    return path && resolve(source, expandHome(path)) === ROOT;
  });
  if (!sourceMode && !installed.length)
    throw new Error(`${ROOT} is not installed in ${source}; use --source for explicit loading`);
  // Start from a small config, excluding unrelated plugins, MCP servers and telemetry.
  const settings: Record<string, unknown> = { packages: sourceMode ? [] : [ROOT] };
  if (generate) {
    for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel']) {
      if (original[key] !== undefined) settings[key] = original[key];
    }
    for (const name of ['auth.json', 'models.json']) {
      try {
        await copyFile(join(source, name), join(destination, name));
        await chmod(join(destination, name), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  await writeFile(join(destination, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
}

export class Terminal {
  output: string;
  observed = '';
  pending: Promise<void> = Promise.resolve();
  closed = false;
  screen: InstanceType<typeof xterm.Terminal>;
  log: number;
  proc: pty.IPty;
  exited?: { exitCode: number; signal?: number };
  exit: Promise<{ exitCode: number; signal?: number }>;
  closing?: Promise<void>;
  static async create(argv: string[], config: string, cwd: string, output: string) {
    // node-pty 1.1.0 ships its macOS helper without the executable bit.
    if (process.platform === 'darwin') {
      const require = createRequire(import.meta.url);
      const helper = join(
        dirname(require.resolve('node-pty/package.json')),
        'prebuilds',
        `darwin-${process.arch}`,
        'spawn-helper',
      );
      try {
        const info = await stat(helper);
        if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o100);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return new Terminal(argv, config, cwd, output);
  }
  constructor(argv: string[], config: string, cwd: string, output: string) {
    this.output = output;
    this.observed = '';
    this.pending = Promise.resolve();
    this.closed = false;
    this.screen = new xterm.Terminal({ cols: 100, rows: 42, allowProposedApi: true });
    this.log = openSync(join(output, 'terminal.log'), 'w', 0o600);
    try {
      this.proc = pty.spawn(argv[0], argv.slice(1), {
        name: 'xterm-256color',
        cols: 100,
        rows: 42,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          PI_CODING_AGENT_DIR: config,
          PI_TELEMETRY: '0',
        },
      });
    } catch (error) {
      closeSync(this.log);
      this.screen.dispose();
      throw error;
    }
    this.screen.onData((data) => {
      if (!this.exited) this.proc.write(data);
    });
    for (const [code, value] of [
      [10, 'd2d2/dddd/ebeb'],
      [11, '0f0f/1414/2525'],
    ] as const) {
      this.screen.parser.registerOscHandler(code, (data) => {
        if (data === '?') {
          this.proc.write(`\x1b]${code};rgb:${value}\x07`);
          return true;
        }
        return false;
      });
    }
    this.proc.onData((data) => {
      if (this.closed) return;
      appendFileSync(this.log, data);
      this.pending = this.pending.then(
        () =>
          new Promise<void>((resolveWrite) =>
            this.screen.write(data, () => {
              this.observed = (this.observed + '\n' + this.text()).slice(-200000);
              resolveWrite();
            }),
          ),
      );
    });
    this.exit = new Promise((resolveExit) =>
      this.proc.onExit((event) => {
        this.exited = event;
        resolveExit(event);
      }),
    );
  }
  text() {
    const buffer = this.screen.buffer.active;
    return Array.from(
      { length: this.screen.rows },
      (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || '',
    ).join('\n');
  }
  write(data: string) {
    this.proc.write(data);
  }
  async wait(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeout = 10000,
    errors = true,
  ) {
    const deadline = performance.now() + timeout;
    while (true) {
      await this.pending;
      if (errors && ERROR.test(this.observed))
        throw new Error(`${label}: Pi reported an error\n${this.text()}`);
      if (await predicate()) return;
      if (this.exited) throw new Error(`Pi exited with status ${this.exited.exitCode}: ${label}`);
      if (performance.now() >= deadline) throw new Error(`Timed out: ${label}\n${this.text()}`);
      await delay(20);
    }
  }
  async send(text: string) {
    await this.pending;
    this.observed = '';
    this.write(text);
    await delay(100);
    this.write('\r');
  }
  async snapshot(name: string) {
    await this.pending;
    await writeFile(join(this.output, name), this.text());
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const signal = (name: NodeJS.Signals) => {
        try {
          if (process.platform === 'win32') this.proc.kill();
          else process.kill(-this.proc.pid, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const untilExit = async (timeout: number) => {
        const deadline = performance.now() + timeout;
        while (!this.exited && performance.now() < deadline) await delay(20);
      };
      try {
        signal('SIGTERM');
        await untilExit(1000);
        signal('SIGKILL');
        await untilExit(3000);
        if (!this.exited) throw new Error('PTY child did not exit after SIGKILL');
      } finally {
        await this.pending;
        this.closed = true;
        this.screen.dispose();
        closeSync(this.log);
      }
    })();
    return this.closing;
  }
}

export async function run(args: SmokeOptions) {
  const output = args.output
    ? resolve(args.output)
    : await mkdtemp(join(tmpdir(), 'pi-character-smoke-'));
  await mkdir(output, { recursive: true });
  console.log(`Artifacts: ${output}`);
  const state = await mkdtemp(join(tmpdir(), 'pi-character-state-'));
  let terminal: Terminal | undefined;
  try {
    const config = join(state, 'agent');
    await mkdir(config, { mode: 0o700 });
    await isolatedConfig(args.config, config, args);
    terminal = await Terminal.create(command(args), config, state, output);
    const cray = await readAsset(join(ROOT, 'assets/cray.json'));
    const hasCray = () =>
      cray.frames.some((frame) =>
        frame.filter((row) => row.trim()).every((row) => terminal!.text().includes(row.trim())),
      );
    await terminal.wait(hasCray, 'startup character', args['startup-timeout']);
    await terminal.snapshot('pi-welcome.txt');
    await terminal.send('/character off');
    await terminal.wait(
      async () =>
        !hasCray() &&
        (await readJson(join(config, 'characters/settings.json'), {})).enabled === false,
      'off',
    );
    await terminal.snapshot('pi-off.txt');
    await terminal.send('/character show');
    await terminal.wait(hasCray, 'show');
    await terminal.snapshot('pi-show.txt');
    terminal.write('draft text');
    await terminal.wait(() => !hasCray() && terminal!.text().includes('draft text'), 'draft hide');
    await terminal.snapshot('pi-draft.txt');
    terminal.write('\x15');
    await terminal.wait(hasCray, 'clear restore');
    await terminal.snapshot('pi-clear.txt');
    console.log('PASS: Pi startup, off/show, draft hide, clear restore');
    if (args.generate) {
      const directory = join(config, 'characters');
      const assets = async () =>
        new Map(
          await Promise.all(
            (await readdir(directory))
              .filter((name) => name.endsWith('.json') && name !== 'settings.json')
              .map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
          ),
        );
      const before = await assets();
      await terminal.send(
        `/character generate ${args.model ? `--model ${args.model} ` : ''}${args.description}`,
      );
      await terminal.wait(
        () => terminal!.text().includes('Keep character'),
        'character preview',
        args['generation-timeout'],
      );
      await terminal.snapshot('pi-preview.txt');
      terminal.write('\r');
      await terminal.wait(
        async () =>
          terminal!.observed.includes('Created ') &&
          [...(await assets())].some(([name, data]) => before.get(name) !== data),
        'character generation',
        15000,
      );
      await terminal.snapshot('pi-generated.txt');
      for (const [name, data] of await assets())
        if (before.get(name) !== data) await writeFile(join(output, name), data);
      console.log('PASS: character generated and saved');
    }
  } finally {
    try {
      if (terminal) {
        try {
          await terminal.snapshot('pi-final.txt');
        } finally {
          await terminal.close();
        }
      }
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    await run(options());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
