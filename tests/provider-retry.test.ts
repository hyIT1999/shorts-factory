/**
 * Transient provider failures (HTTP 429, 5xx, timeouts, network errors) are
 * retried with the injected policy; misconfiguration, refusals and 4xx are
 * not. Fake fetch / fake SDK client, injected sleep: no network, no waiting.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestError, InternalServerError, RateLimitError } from 'openai';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { createAIClientFromEnv, type ProviderRequest } from '../lib/ai/client.js';
import { AIError } from '../lib/ai/errors.js';
import { GeminiProvider } from '../lib/ai/providers/gemini.js';
import { OpenAIProvider, toAIError, type ResponsesApi } from '../lib/ai/providers/openai.js';
import type { RetryPolicy } from '../lib/retry.js';
import { VoiceError } from '../lib/voice/errors.js';
import { createVoiceProviderFromEnv } from '../lib/voice/index.js';
import { GeminiTtsProvider } from '../lib/voice/providers/gemini.js';
import type { VoiceRequest } from '../lib/voice/types.js';
import { parseWav } from '../lib/voice/wav.js';

const policy: RetryPolicy = { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 };
const quiet = (): void => {};

function recorder() {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { delays, sleep };
}

/** A fetch that answers with each response in turn and repeats the last one. */
function sequence(responses: (() => Response)[]) {
  let index = 0;
  const calls: RequestInit[] = [];
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    calls.push(init);
    const respond = responses[Math.min(index, responses.length - 1)];
    index++;
    assert.ok(respond);
    return respond();
  };
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const aiOk = () => json({ candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] }, finishReason: 'STOP' }] });
const quotaError = (status: number, headers: Record<string, string> = {}, details?: unknown[]) =>
  json({ error: { message: 'Resource exhausted', ...(details ? { details } : {}) } }, status, headers);

const request: ProviderRequest = {
  systemPrompt: 'system',
  userPrompt: 'user',
  jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  schemaName: 'research',
};

function isAIError(code: AIError['code'], retryable?: boolean) {
  return (error: unknown) =>
    error instanceof AIError && error.code === code && (retryable === undefined || error.retryable === retryable);
}

describe('GeminiProvider retries', () => {
  const gemini = (fetchFn: (url: string, init: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) =>
    new GeminiProvider({ apiKey: 'test-key', model: 'gemini-test', fetch: fetchFn, retry: policy, log: quiet, ...extra });

  test('429 then 200: retried after the Retry-After hint and the result is returned', async () => {
    const { delays, sleep } = recorder();
    const { fetchFn, calls } = sequence([() => quotaError(429, { 'retry-after': '2' }), aiOk]);
    const logs: string[] = [];
    const result = await gemini(fetchFn, { sleep, log: (message) => logs.push(message) }).generateJson(request);
    assert.deepEqual(result, { answer: 'ok' });
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [2_000]);
    assert.match(logs[0] ?? '', /Gemini research: .*HTTP 429.*retry 1 of 2 in 2 s/);
  });

  test('Google RetryInfo.retryDelay is used when there is no Retry-After header', async () => {
    const { delays, sleep } = recorder();
    const details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }];
    const { fetchFn } = sequence([() => quotaError(429, {}, details), aiOk]);
    await gemini(fetchFn, { sleep }).generateJson(request);
    assert.deepEqual(delays, [3_000]);
  });

  test('503 is retried with backoff until the attempts run out; the last error is thrown', async () => {
    const { delays, sleep } = recorder();
    const { fetchFn, calls } = sequence([() => json({ error: { message: 'unavailable' } }, 503)]);
    await assert.rejects(gemini(fetchFn, { sleep }).generateJson(request), isAIError('AI_API_ERROR', true));
    assert.equal(calls.length, 3, 'one request per attempt');
    assert.equal(delays.length, 2);
    for (const delay of delays) {
      assert.ok(delay >= 800 && delay <= 5_000, `jittered backoff, got ${delay}`);
    }
  });

  test('timeouts and network errors are retried', async () => {
    for (const failure of [() => new DOMException('timed out', 'TimeoutError'), () => new TypeError('fetch failed')]) {
      const { delays, sleep } = recorder();
      let calls = 0;
      const fetchFn = async (): Promise<Response> => {
        calls++;
        throw failure();
      };
      await assert.rejects(gemini(fetchFn, { sleep }).generateJson(request), (error: unknown) => error instanceof AIError && error.retryable);
      assert.equal(calls, 3);
      assert.equal(delays.length, 2);
    }
  });

  test('400, 403 and refusals are not retried', async () => {
    const cases: [() => Response, AIError['code']][] = [
      [() => json({ error: { message: 'bad schema' } }, 400), 'AI_API_ERROR'],
      [() => json({ error: { message: 'denied' } }, 403), 'AI_AUTH'],
      [() => json({ promptFeedback: { blockReason: 'SAFETY' } }), 'AI_REFUSAL'],
    ];
    for (const [respond, code] of cases) {
      const { delays, sleep } = recorder();
      const { fetchFn, calls } = sequence([respond]);
      await assert.rejects(gemini(fetchFn, { sleep }).generateJson(request), isAIError(code, false));
      assert.equal(calls.length, 1);
      assert.deepEqual(delays, []);
    }
  });

  test('a provider constructed without a policy never retries', async () => {
    const { fetchFn, calls } = sequence([() => quotaError(429), aiOk]);
    const provider = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-test', fetch: fetchFn });
    await assert.rejects(provider.generateJson(request), isAIError('AI_RATE_LIMIT', true));
    assert.equal(calls.length, 1);
  });
});

function openAIResponse(outputText: string): OpenAIResponse {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [],
    output_text: outputText,
    incomplete_details: null,
  } as unknown as OpenAIResponse;
}

/** A fake Responses API that throws each failure in turn, then answers. */
function flakyApi(failures: Error[], result: OpenAIResponse): ResponsesApi & { calls: number } {
  let index = 0;
  const api = {
    calls: 0,
    responses: {
      create: async () => {
        api.calls++;
        const failure = failures[index];
        index++;
        if (failure) {
          throw failure;
        }
        return result;
      },
    },
  };
  return api;
}

describe('OpenAIProvider retries', () => {
  test('a rate limit is retried after its Retry-After header', async () => {
    const { delays, sleep } = recorder();
    const api = flakyApi([new RateLimitError(429, undefined, 'slow down', new Headers({ 'retry-after': '4' }))], openAIResponse('{"answer":"ok"}'));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'm', client: api, retry: policy, sleep, log: quiet });
    assert.deepEqual(await provider.generateJson(request), { answer: 'ok' });
    assert.equal(api.calls, 2);
    assert.deepEqual(delays, [4_000]);
  });

  test('5xx is retryable, 4xx is not; nothing leaks key material', () => {
    const headers = new Headers();
    assert.equal(toAIError(new InternalServerError(500, undefined, 'boom', headers)).retryable, true);
    assert.equal(toAIError(new BadRequestError(400, undefined, 'Invalid schema sk-abc', headers)).retryable, false);
    const limited = toAIError(new RateLimitError(429, undefined, 'slow', new Headers({ 'retry-after': '9' })));
    assert.deepEqual([limited.code, limited.retryable, limited.retryAfterMs], ['AI_RATE_LIMIT', true, 9_000]);
  });

  test('a bad request stops after one call', async () => {
    const { delays, sleep } = recorder();
    const api = flakyApi([new BadRequestError(400, undefined, 'Invalid schema', new Headers())], openAIResponse('{}'));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'm', client: api, retry: policy, sleep, log: quiet });
    await assert.rejects(provider.generateJson(request), isAIError('AI_API_ERROR', false));
    assert.equal(api.calls, 1);
    assert.deepEqual(delays, []);
  });
});

describe('GeminiTtsProvider retries', () => {
  const voiceRequest: VoiceRequest = { text: 'Bạn có bao giờ tự hỏi vì sao mình lại mơ?', language: 'vi', voice: 'Charon', speed: 1, sceneIndex: 0 };
  const pcm = Buffer.alloc(24_000 * 2).toString('base64');
  const audioOk = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16; rate=24000; channels=1', data: pcm } }] }, finishReason: 'STOP' }] });
  const tts = (fetchFn: (url: string, init: RequestInit) => Promise<Response>, sleep: (ms: number) => Promise<void>) =>
    new GeminiTtsProvider({ apiKey: 'test-key', model: 'tts-test', fetch: fetchFn, retry: policy, sleep, log: quiet });

  test('429 twice then audio: two retries, then a valid WAV', async () => {
    const { delays, sleep } = recorder();
    const { fetchFn, calls } = sequence([() => quotaError(429, { 'retry-after': '1' }), () => quotaError(429, { 'retry-after': '2' }), audioOk]);
    const result = await tts(fetchFn, sleep).synthesize(voiceRequest);
    assert.equal(parseWav(result.audio).durationSec, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  test('a third 429 fails the request as VOICE_RATE_LIMIT (retryable) after the attempts run out', async () => {
    const { delays, sleep } = recorder();
    const { fetchFn, calls } = sequence([() => quotaError(429)]);
    await assert.rejects(
      tts(fetchFn, sleep).synthesize(voiceRequest),
      (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_RATE_LIMIT' && error.retryable,
    );
    assert.equal(calls.length, 3);
    assert.equal(delays.length, 2);
  });

  test('credentials and configuration errors are not retried', async () => {
    const { delays, sleep } = recorder();
    const { fetchFn, calls } = sequence([() => json({ error: { message: 'denied' } }, 403)]);
    await assert.rejects(tts(fetchFn, sleep).synthesize(voiceRequest), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_AUTH' && !error.retryable);
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
    await assert.rejects(tts(fetchFn, sleep).synthesize({ ...voiceRequest, voice: '' }), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIG');
    assert.equal(calls.length, 1, 'no request without a voice');
  });
});

describe('factories read PROVIDER_RETRY_*', () => {
  test('invalid values are configuration errors of the provider being built', () => {
    assert.throws(
      () => createAIClientFromEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm', PROVIDER_RETRY_ATTEMPTS: '0' }),
      (error: unknown) => error instanceof AIError && error.code === 'AI_CONFIG' && /PROVIDER_RETRY_ATTEMPTS/.test(error.message),
    );
    assert.throws(
      () => createVoiceProviderFromEnv({ VOICE_PROVIDER: 'gemini', PROVIDER_RETRY_BASE_MS: 'soon' }),
      (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIG' && /PROVIDER_RETRY_BASE_MS/.test(error.message),
    );
    assert.ok(createAIClientFromEnv({ AI_PROVIDER: 'mock', PROVIDER_RETRY_ATTEMPTS: '0' }), 'the mock provider ignores the retry settings');
    assert.equal(createVoiceProviderFromEnv({ VOICE_PROVIDER: 'gemini', PROVIDER_RETRY_ATTEMPTS: '2' }).name, 'gemini');
  });
});
