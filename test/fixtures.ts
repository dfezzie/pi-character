import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type TestModel = NonNullable<ExtensionContext['model']>;
export type TestRegistry = Pick<ExtensionContext['modelRegistry'], 'complete'>;
export type TestResponse = Awaited<ReturnType<TestRegistry['complete']>>;

export function testModel(id: string): TestModel {
  return {
    id,
    name: id,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://example.invalid',
    input: ['text'],
    reasoning: false,
    contextWindow: 10000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function testResponse(overrides: Partial<TestResponse> = {}): TestResponse {
  return {
    role: 'assistant',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'fixture',
    timestamp: 0,
    stopReason: 'stop',
    content: [],
    usage: {
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}
