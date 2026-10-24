import test, { type TestContext } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createCharacterExtension } from '../src/index.ts';
import * as storage from '../src/character.ts';
import { testModel, testResponse } from './fixtures.ts';

const deferred = <T = any>() => {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = (value) => r(value as T);
  });
  return { promise, resolve };
};
const model = testModel('current');
const other = testModel('chosen');
const artwork = {
  name: 'Generated Moon',
  color: 'cyan',
  frame_ms: 200,
  frames: Array.from({ length: 6 }, (_, i) => [i % 2 ? '(o)' : '(-)', ' | ', '/ \\', '___']),
};
const response = testResponse({
  content: [{ type: 'text', text: JSON.stringify(artwork) }],
});

async function harness(t: TestContext, overrides: Partial<typeof storage> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-character-lifecycle-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  // This intentionally partial host records heterogeneous UI calls for assertions.
  const handlers: Record<string, (...args: any[]) => Promise<void>> = {},
    events: any[][] = [];
  let command: (args: string, ctx: any) => Promise<void>;
  let widget: any;
  const pi = {
    on: (event: string, handler: (...args: any[]) => Promise<void>) => {
      handlers[event] = handler;
    },
    registerCommand: (_: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
  };
  const ctx: any = {
    mode: 'tui',
    cwd: root,
    model,
    modelRegistry: {
      complete: async () => response,
      getAll: () => [model, other],
      find: (p: string, id: string) =>
        p === other.provider && id === other.id ? other : undefined,
    },
    ui: {
      notify: (...args: any[]) => events.push(['notify', ...args]),
      setStatus: (...args: any[]) => events.push(['status', ...args]),
      setWidget: (_: string, factory: any) => {
        widget?.dispose();
        widget = undefined;
        events.push(['widget', !!factory]);
        if (factory)
          widget = factory(
            {
              terminal: { rows: 40 },
              requestRender: () => events.push(['render']),
            },
            { fg: (_color: string, text: string) => text },
          );
      },
      getEditorText: () => '',
      select: async (_: string, options: string[]) => options[0],
      custom: async () => (await storage.listAssets(join(root, 'characters')))[0]?.id ?? null,
    },
  };
  createCharacterExtension(pi as unknown as ExtensionAPI, { ...storage, ...overrides });
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prior;
  t.after(async () => {
    await handlers.session_shutdown({}, ctx);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    ctx,
    events,
    caption: () =>
      widget ? stripVTControlCharacters(widget.render(100).at(-2) || '').trim() : undefined,
    handlers,
    command: (args: string) => command(args, ctx),
    start: () => handlers.session_start({}, ctx),
    shutdown: () => handlers.session_shutdown({}, ctx),
    preferences: async () =>
      JSON.parse(await readFile(join(root, 'characters/settings.json'), 'utf8')),
  };
}

test('startup is local; explicit generation saves metadata without changing current model', async (t) => {
  const h = await harness(t);
  let calls = 0;
  h.ctx.modelRegistry.complete = async (selected: typeof model, context: any) => {
    calls++;
    assert.equal(selected, other);
    assert.equal(context.messages[0].content[0].text, 'moon');
    return response;
  };
  await h.start();
  assert.equal(calls, 0);
  await h.command('generate --model openai-codex/chosen moon');
  assert.equal(calls, 1);
  assert.equal(h.ctx.model, model);
  assert.ok(h.events.some((e) => e[1]?.startsWith?.('Created Generated Moon')));
  const prefs = await h.preferences();
  const asset = JSON.parse(
    await readFile(join(h.root, `characters/${prefs.selected}.json`), 'utf8'),
  );
  assert.equal(asset.model, 'openai-codex/chosen');
  assert.equal(asset.description, 'moon');
});

test('color preference survives generation and invalid colors preserve it', async (t) => {
  const h = await harness(t);
  await h.start();
  await h.command('color pink');
  assert.equal((await h.preferences()).color, 'pink');
  await h.command('generate moon');
  assert.equal((await h.preferences()).color, 'pink');
  assert.equal((await storage.readSettings(join(h.root, 'characters'))).color, 'pink');
  await h.command('color invalid');
  assert.equal((await h.preferences()).color, 'pink');
  await h.command('color default');
  assert.equal((await h.preferences()).color, 'default');
});

test('provider failure and invalid artwork preserve the existing selection', async (t) => {
  const h = await harness(t);
  await h.start();
  await h.command('show');
  const before = await h.preferences();
  for (const result of [
    { stopReason: 'error', errorMessage: '400 model_not_found secret' },
    { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] },
  ]) {
    h.ctx.modelRegistry.complete = async () => result;
    await h.command('generate moon');
    assert.deepEqual(await h.preferences(), before);
  }
  assert.ok(h.events.some((e) => /unsupported/.test(e[1])));
  assert.ok(h.events.some((e) => /invalid character/.test(e[1])));
  assert.ok(!JSON.stringify(h.events).includes('secret'));
});

test('cancel releases request and next generation works despite late provider success', async (t) => {
  const h = await harness(t);
  await h.start();
  const pending = deferred(),
    entered = deferred();
  h.ctx.modelRegistry.complete = () => {
    entered.resolve();
    return pending.promise;
  };
  const first = h.command('generate first');
  await entered.promise;
  await h.command('generate duplicate');
  assert.ok(h.events.some((e) => /Already generating/.test(e[1])));
  await h.command('cancel');
  await first;
  h.ctx.modelRegistry.complete = async () => response;
  await h.command('generate second');
  const before = await h.preferences();
  const count = h.events.length;
  pending.resolve(response);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await h.preferences(), before);
  assert.equal(h.events.length, count);
});

test('generation spinner moves during an existing session and stops on cancel', async (t) => {
  const h = await harness(t);
  await h.start();
  await h.handlers.agent_start({}, h.ctx);
  const entered = deferred();
  h.ctx.modelRegistry.complete = () => {
    entered.resolve();
    return new Promise(() => {});
  };
  const request = h.command('generate moon');
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const statuses = h.events
    .filter((e) => e[0] === 'status' && typeof e[2] === 'string')
    .map((e) => e[2]);
  assert.ok(new Set(statuses.map((s) => s[0])).size >= 2);
  assert.ok(statuses.every((s) => /Generating character… \d+s/.test(s)));
  await h.command('cancel');
  await request;
  assert.equal(h.events.filter((e) => e[0] === 'status').at(-1)?.[2], undefined);
  const count = h.events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(h.events.length, count);
});

test('picker deletion persists for bundled characters across startup', async (t) => {
  const h = await harness(t);
  await h.start();
  const dir = join(h.root, 'characters');
  const asset = (await storage.listAssets(dir))[0];
  h.ctx.ui.custom = async () => `delete:${asset.id}`;
  h.ctx.ui.confirm = async () => true;
  await h.command('select');
  assert.ok((await h.preferences()).deleted.includes(asset.id));
  assert.ok(!(await storage.listAssets(dir)).some((a) => a.id === asset.id));
  await h.start();
  assert.ok(!(await storage.listAssets(dir)).some((a) => a.id === asset.id));
  assert.notEqual((await h.preferences()).selected, asset.id);
});

test('reimport restores a deleted character in the picker and across restart', async (t) => {
  const h = await harness(t);
  await h.start();
  const dir = join(h.root, 'characters');
  const dozy = (await storage.listAssets(dir)).find((a) => a.sprite.name.includes('Dozy'))!;
  h.ctx.ui.custom = async () => `delete:${dozy.id}`;
  h.ctx.ui.confirm = async () => true;
  await h.command('select');
  await h.command(`import ${new URL('../assets/dozy.json', import.meta.url).pathname}`);
  assert.equal((await h.preferences()).selected, dozy.id);
  assert.ok(!(await h.preferences()).deleted.includes(dozy.id));
  assert.equal(h.caption(), dozy.sprite.name);
  await h.command('off');
  h.ctx.ui.custom = async () => dozy.id;
  await h.command('select');
  assert.equal((await h.preferences()).enabled, true);
  await h.start();
  assert.equal(h.caption(), dozy.sprite.name);
});

for (const action of ['select', 'import']) {
  test(`failed ${action} preferences do not leak into later color changes`, async (t) => {
    let fail = false;
    const h = await harness(t, {
      atomicJson: async (...args) => {
        if (fail) {
          fail = false;
          throw new Error('EACCES');
        }
        return storage.atomicJson(...args);
      },
    });
    await h.start();
    await h.command('show');
    const before = await h.preferences();
    const caption = h.caption();
    const dozy = (await storage.listAssets(join(h.root, 'characters'))).find((a) =>
      a.sprite.name.includes('Dozy'),
    )!;
    h.ctx.ui.custom = async () => dozy.id;
    fail = true;
    await h.command(
      action === 'select'
        ? action
        : `import ${new URL('../assets/dozy.json', import.meta.url).pathname}`,
    );
    assert.ok(h.events.some((e) => e[0] === 'notify' && /EACCES/.test(e[1])));
    assert.deepEqual(await h.preferences(), before);
    assert.equal(h.caption(), caption);
    await h.command('color pink');
    assert.equal((await h.preferences()).selected, before.selected);
    assert.equal(h.caption(), caption);
    await h.start();
    assert.equal(h.caption(), caption);
  });
}

for (const reroll of [false, true]) {
  test(`${reroll ? 'reroll' : 'generation'} finishes its preference commit consistently despite newer commands`, async (t) => {
    const saving = deferred(),
      release = deferred();
    let pause = false;
    const h = await harness(t, {
      atomicJson: async (...args) => {
        if (pause) {
          pause = false;
          saving.resolve();
          await release.promise;
        }
        return storage.atomicJson(...args);
      },
    });
    await h.start();
    await h.command('show');
    const dir = join(h.root, 'characters');
    const source = (await storage.listAssets(dir)).find((a) => a.sprite.name.includes('Dozy'))!;
    h.ctx.ui.custom = async () => `reroll:${source.id}`;
    pause = true;
    const request = h.command(reroll ? 'select' : 'generate moon');
    try {
      await saving.promise;
      const caption = h.caption();
      const status = h.events.filter((e) => e[0] === 'status').at(-1)?.[2];
      assert.match(status, /Saving character/);
      assert.ok(!status.includes('/character cancel'));
      for (const command of ['cancel', 'off', 'color pink']) await h.command(command);
      assert.equal(h.caption(), caption);
      assert.ok(h.events.some((e) => e[0] === 'notify' && /save.*finish/i.test(e[1])));
      release.resolve();
      await request;
      const saved = await h.preferences();
      assert.equal(saved.enabled, true);
      assert.equal(saved.color, undefined);
      assert.equal(
        (await storage.listAssets(dir)).find((a) => a.id === saved.selected)?.sprite.name,
        caption,
      );
      if (reroll) {
        assert.ok(saved.deleted.includes(source.id));
        assert.ok(!(await storage.listAssets(dir)).some((a) => a.id === source.id));
      }
      await h.start();
      assert.equal(h.caption(), caption);
    } finally {
      release.resolve();
      await request;
    }
  });
}

test('a failed generation preference commit restores the previous character and allows retry', async (t) => {
  let fail = false;
  const h = await harness(t, {
    atomicJson: async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('EACCES');
      }
      return storage.atomicJson(...args);
    },
  });
  await h.start();
  await h.command('show');
  const before = await h.preferences(),
    caption = h.caption();
  fail = true;
  await h.command('generate moon');
  assert.deepEqual(await h.preferences(), before);
  assert.equal(h.caption(), caption);
  assert.ok(
    h.events.some((e) => e[0] === 'notify' && /directory permissions and free disk/.test(e[1])),
  );
  await h.command('generate moon');
  assert.equal(h.caption(), artwork.name);
  await h.start();
  assert.equal(h.caption(), artwork.name);
});

test('picker reroll keeps source on failure and replaces it only after success', async (t) => {
  const h = await harness(t);
  await h.start();
  const dir = join(h.root, 'characters');
  const id = await storage.saveAsset(dir, artwork, 'a friendly moon', 'openai-codex/chosen');
  h.ctx.ui.custom = async () => `reroll:${id}`;
  h.ctx.modelRegistry.complete = async () => {
    throw new Error('offline');
  };
  await h.command('select');
  assert.ok((await storage.listAssets(dir)).some((a) => a.id === id));
  const changed = { ...artwork, color: 'pink' };
  h.ctx.modelRegistry.complete = async (selected: typeof model, context: any) => {
    assert.equal(selected, other);
    assert.equal(context.messages[0].content[0].text, 'a friendly moon');
    return { ...response, content: [{ type: 'text', text: JSON.stringify(changed) }] };
  };
  await h.command('select');
  const assets = await storage.listAssets(dir);
  assert.ok(!assets.some((a) => a.id === id));
  const prefs = await h.preferences();
  assert.ok(prefs.deleted.includes(id));
  assert.equal(assets.find((a) => a.id === prefs.selected)?.sprite.name, artwork.name);
});

test('generation previews without saving, rerolls, then saves only the kept design', async (t) => {
  const h = await harness(t);
  await h.start();
  await h.command('show');
  const dir = join(h.root, 'characters');
  const before = await storage.listAssets(dir);
  const prefs = await h.preferences();
  let calls = 0,
    reviews = 0;
  h.ctx.modelRegistry.complete = async () => {
    calls++;
    return {
      ...response,
      content: [{ type: 'text', text: JSON.stringify({ ...artwork, name: `Attempt ${calls}` }) }],
    };
  };
  h.ctx.ui.select = async () => {
    assert.deepEqual(await h.preferences(), prefs);
    assert.equal((await storage.listAssets(dir)).length, before.length);
    return ++reviews === 1 ? 'Reroll (uses tokens)' : 'Keep character';
  };
  await h.command('generate moon');
  assert.equal(calls, 2);
  const assets = await storage.listAssets(dir);
  assert.ok(!assets.some((a) => a.sprite.name === 'Attempt 1'));
  const saved = await h.preferences();
  assert.equal(assets.find((a) => a.id === saved.selected)?.sprite.name, 'Attempt 2');
});

test('cancelling generated preview preserves cache and preferences', async (t) => {
  const h = await harness(t);
  await h.start();
  await h.command('off');
  const dir = join(h.root, 'characters');
  const before = await storage.listAssets(dir),
    prefs = await h.preferences();
  h.ctx.ui.select = async () => 'Cancel';
  await h.command('generate moon');
  assert.deepEqual(await storage.listAssets(dir), before);
  assert.deepEqual(await h.preferences(), prefs);
  assert.equal(h.events.filter((e) => e[0] === 'widget').at(-1)?.[1], false);
});

test('off wins over pending generation and late success cannot re-enable character', async (t) => {
  const h = await harness(t);
  await h.start();
  const pending = deferred(),
    entered = deferred();
  h.ctx.modelRegistry.complete = () => {
    entered.resolve();
    return pending.promise;
  };
  const request = h.command('generate moon');
  await entered.promise;
  await h.command('off');
  await request;
  pending.resolve(response);
  await new Promise((r) => setImmediate(r));
  assert.equal((await h.preferences()).enabled, false);
  assert.equal(h.events.filter((e) => e[0] === 'widget').at(-1)?.[1], false);
});

test('shutdown during asset save suppresses stale preferences and all later UI', async (t) => {
  const saving = deferred(),
    release = deferred();
  const h = await harness(t, {
    saveAsset: async (...args) => {
      if (storage.validate(args[1]).name === artwork.name) {
        saving.resolve();
        await release.promise;
      }
      return storage.saveAsset(...args);
    },
  });
  await h.start();
  await h.command('show');
  const before = await h.preferences();
  const request = h.command('generate moon');
  await saving.promise;
  await h.shutdown();
  const count = h.events.length;
  release.resolve();
  await request;
  assert.deepEqual(await h.preferences(), before);
  assert.equal(h.events.length, count);
});

test('shutdown during startup prevents late widget and error notifications', async (t) => {
  const reading = deferred(),
    release = deferred();
  const h = await harness(t, {
    readSettings: async () => {
      reading.resolve();
      await release.promise;
      throw new Error('late startup failure');
    },
  });
  const startup = h.start();
  await reading.promise;
  await h.shutdown();
  const count = h.events.length;
  release.resolve();
  await startup;
  assert.equal(h.events.length, count);
});

test('replacement session ignores old request results and shutdown disposes animation', async (t) => {
  const h = await harness(t);
  await h.start();
  const pending = deferred(),
    entered = deferred();
  h.ctx.modelRegistry.complete = () => {
    entered.resolve();
    return pending.promise;
  };
  const request = h.command('generate moon');
  await entered.promise;
  await h.shutdown();
  await request;
  await h.start();
  const count = h.events.length;
  pending.resolve(response);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.events.length, count);
  await h.shutdown();
  const after = h.events.length;
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(h.events.length, after);
});

test('model listing and invalid model override never invoke a provider', async (t) => {
  const h = await harness(t);
  await h.start();
  h.ctx.modelRegistry.complete = () => assert.fail('no provider call');
  await h.command('models');
  await h.command('generate --model absent/model moon');
  assert.ok(h.events.some((e) => /openai-codex\/chosen/.test(e[1])));
  assert.ok(h.events.some((e) => /Unknown model/.test(e[1])));
});

for (const command of ['show', 'select', 'import']) {
  test(`${command} supersedes a generation whose provider finishes late`, async (t) => {
    const h = await harness(t);
    await h.start();
    const pending = deferred(),
      entered = deferred();
    h.ctx.modelRegistry.complete = () => {
      entered.resolve();
      return pending.promise;
    };
    const request = h.command('generate moon');
    await entered.promise;
    const argument =
      command === 'import'
        ? `import ${new URL('../assets/dozy.json', import.meta.url).pathname}`
        : command;
    await h.command(argument);
    await request;
    const before = await h.preferences();
    const count = h.events.length;
    pending.resolve(response);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await h.preferences(), before);
    assert.equal(h.events.length, count);
  });
}

test('shutdown awaits an issued preference write and prevents its later UI', async (t) => {
  const saving = deferred(),
    release = deferred();
  const h = await harness(t, {
    atomicJson: async (...args) => {
      saving.resolve();
      await release.promise;
      return storage.atomicJson(...args);
    },
  });
  await h.start();
  const request = h.command('generate moon');
  await saving.promise;
  let finished = false;
  const shutdown = h.shutdown().then(() => {
    finished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);
  const count = h.events.length;
  release.resolve();
  await shutdown;
  await request;
  assert.equal(h.events.length, count);
  assert.equal(finished, true);
});

test('save failure keeps preferences intact and explains local storage remediation', async (t) => {
  const h = await harness(t, {
    saveAsset: async (...args) => {
      if (storage.validate(args[1]).name === artwork.name)
        throw new Error('EACCES private storage detail');
      return storage.saveAsset(...args);
    },
  });
  await h.start();
  await h.command('show');
  const before = await h.preferences();
  await h.command('generate moon');
  assert.deepEqual(await h.preferences(), before);
  assert.ok(h.events.some((e) => /directory permissions and free disk/.test(e[1])));
  assert.ok(!JSON.stringify(h.events).includes('private storage detail'));
});
