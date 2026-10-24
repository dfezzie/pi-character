import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeGeneration,
  generationError,
  generationRequest,
  GenerationStopped,
} from '../src/generation.ts';
import { testModel, testResponse, type TestRegistry } from './fixtures.ts';

const model = testModel('example');
const stopped = async (controller: AbortController, reason: string) => {
  const promise = completeGeneration(
    { complete: () => new Promise(() => {}) },
    model,
    'system',
    'moon',
    controller,
    1000,
  );
  controller.abort(reason);
  await assert.rejects(promise, (e) => e instanceof GenerationStopped && e.message === reason);
};

test('default model identity is preserved and override is request scoped', () => {
  const other = { provider: 'other', id: 'nested/model' };
  const registry = {
    find: (provider: string, id: string) =>
      provider === 'other' && id === 'nested/model' ? other : undefined,
  };
  assert.equal(generationRequest('moon', model, registry).model, model);
  assert.deepEqual(generationRequest('--model other/nested/model moon', model, registry), {
    model: other,
    description: 'moon',
  });
  assert.equal(model.id, 'example');
  assert.throws(() => generationRequest('--model other/no moon', model, registry), /Unknown model/);
  assert.throws(() => generationRequest('--model incomplete', model, registry), /Usage/);
  assert.throws(() => generationRequest('', model, registry), /description/);
  assert.throws(() => generationRequest('a'.repeat(1001), model, registry), /description/);
  assert.throws(() => generationRequest('moon', undefined, registry), /Select a model/);
});

test('dedicated completion sends only description, prompt, and bounded output', async () => {
  const controller = new AbortController();
  const result = testResponse();
  const registry: TestRegistry = {
    complete: async (actualModel, context, options) => {
      assert.equal(actualModel, model);
      assert.equal(context.systemPrompt, 'system');
      assert.equal(context.messages.length, 1);
      assert.deepEqual(context.messages[0].content, [{ type: 'text', text: 'moon' }]);
      assert.equal(context.tools, undefined);
      assert.equal(options?.maxTokens, 4096);
      assert.equal(options?.signal, controller.signal);
      return result;
    },
  };
  assert.equal(await completeGeneration(registry, model, 'system', 'moon', controller), result);
});

test('cancel settles promptly even when provider never settles', async () =>
  stopped(new AbortController(), 'cancelled'));
test('pre-aborted request never invokes provider', async () => {
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(
    completeGeneration(
      {
        complete() {
          assert.fail('must not request');
        },
      },
      model,
      '',
      '',
      controller,
    ),
    GenerationStopped,
  );
});
test('timeout aborts ignored provider and late rejection remains handled', async () => {
  let reject!: (error: Error) => void;
  const controller = new AbortController();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      completeGeneration(
        {
          complete: () =>
            new Promise((_, r) => {
              reject = r;
            }),
        },
        model,
        '',
        '',
        controller,
        10,
      ),
      /timed out/,
    );
    assert.equal(controller.signal.aborted, true);
    reject(new Error('late provider failure'));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    clearTimeout(keepAlive);
  }
});
test('provider stop reasons are failures, never partial successful artwork', async () => {
  for (const stopReason of ['error', 'aborted', 'length', 'toolUse'] as const) {
    await assert.rejects(
      completeGeneration(
        { complete: async () => testResponse({ stopReason }) },
        model,
        '',
        '',
        new AbortController(),
      ),
      /Generation ended/,
    );
  }
});
test('provider errors are actionable and raw payloads never leak', () => {
  for (const [raw, expected] of [
    ['400 model_not_found secret-token', /unavailable or unsupported/],
    ['401 API key secret-token', /Check \/login/],
    ['Provider is not configured: secret-token', /Check \/login/],
    ['429 quota secret-token', /quota/],
    ['network secret-token', /connection/],
    ['Generation ended: length', /output limit/],
    ['Invalid frame dimensions', /invalid character data/],
  ] as const) {
    const text = generationError(new Error(raw), model);
    assert.match(text, expected);
    assert.ok(!text.includes('secret-token'));
  }
});
