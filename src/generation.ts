import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type ModelIdentity = { provider: string; id: string };
type GenerationRegistry = Pick<ExtensionContext['modelRegistry'], 'complete'>;
// Generation helpers deliberately contain no authentication or global model mutation.
export function generationRequest<T extends ModelIdentity>(
  argument: string,
  currentModel: T | undefined,
  registry: { find(provider: string, id: string): T | undefined },
) {
  let description = argument.trim();
  let model = currentModel;
  if (description.startsWith('--model')) {
    const match = /^--model\s+(\S+)\s+([\s\S]+)$/.exec(description);
    if (!match || !match[1].includes('/'))
      throw new Error('Usage: /character generate --model provider/model-id <description>');
    const slash = match[1].indexOf('/');
    model = registry.find(match[1].slice(0, slash), match[1].slice(slash + 1));
    if (!model)
      throw new Error(`Unknown model ${match[1]}. Use /character models for registered choices.`);
    description = match[2].trim();
  }
  if (!description || description.length > 1000)
    throw new Error('Supply a description of 1–1000 characters.');
  if (!model)
    throw new Error(
      'Select a model in Pi first, or use /character generate --model provider/model-id <description>.',
    );
  return { model, description };
}

export class GenerationStopped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GenerationStopped';
  }
}

// Race the provider so cancellation remains usable even if it ignores the signal.
// Promise.race installs rejection handlers on the abandoned provider promise too.
export async function completeGeneration(
  registry: GenerationRegistry,
  model: NonNullable<ExtensionContext['model']>,
  prompt: string,
  description: string,
  controller: AbortController,
  timeoutMs = 120_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new GenerationStopped(controller.signal.reason || 'cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    timer = setTimeout(() => controller.abort('timed out after two minutes'), timeoutMs);
    timer.unref?.();
  });
  try {
    if (controller.signal.aborted) return await aborted;
    const result = await Promise.race([
      aborted,
      Promise.resolve().then(() =>
        registry.complete(
          model,
          {
            systemPrompt: prompt,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: description }],
                timestamp: Date.now(),
              },
            ],
          },
          { signal: controller.signal, maxTokens: 4096 },
        ),
      ),
    ]);
    if (controller.signal.aborted)
      throw new GenerationStopped(controller.signal.reason || 'cancelled');
    if (result.stopReason !== 'stop') {
      // Never echo raw provider payloads: they may contain headers or credentials.
      const detail = result.errorMessage || `Generation ended: ${result.stopReason}`;
      throw new Error(detail);
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export function generationError(error: unknown, model: ModelIdentity, phase = 'request') {
  if (error instanceof GenerationStopped)
    return `Generation ${error.message}. Existing character kept.`;
  const detail = String(
    error != null && typeof error === 'object' && 'message' in error ? error.message : error,
  );
  const label = `${model.provider}/${model.id}`;
  if (phase === 'saving')
    return 'Could not save the generated character. Check character directory permissions and free disk space. Existing character kept.';
  if (phase === 'validation')
    return `Generation with ${label} returned invalid character data. Try a simpler description or another model. Existing character kept.`;
  const choose =
    'Use /character models, then /character generate --model provider/model-id <description>. Pi’s current model is unchanged.';
  if (/model_not_found|not supported|unknown model|does not exist/i.test(detail))
    return `${label} is unavailable or unsupported by this provider/account. ${choose}`;
  if (
    /401|403|unauthori[sz]ed|api.?key|auth|credential|login|provider is not configured/i.test(
      detail,
    )
  )
    return `Authentication or access failed for ${label}. Check /login for ${model.provider} and account access. ${choose}`;
  if (/429|rate.?limit|quota|billing|credit/i.test(detail))
    return `Rate limit or quota reached for ${label}. Check provider quota and retry later. No automatic retry.`;
  if (/max.?tokens|length|token.?limit/i.test(detail))
    return `Generation with ${label} exceeded its output limit. Try a simpler description or another model. Existing character kept.`;
  if (
    /SyntaxError|JSON|character|frame|palette|pose|ASCII|fields/i.test(
      `${error instanceof Error ? error.name : ''}: ${detail}`,
    )
  )
    return `Generation with ${label} returned invalid character data. Try a simpler description or another model. Existing character kept.`;
  return `Generation failed with ${label}. Check provider availability, connection, and account access; try again or choose a model with /character models. Existing character kept.`;
}
