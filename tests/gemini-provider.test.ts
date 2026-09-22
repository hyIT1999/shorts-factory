/**
 * GeminiProvider tests with a fake fetch — no real Gemini API calls.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AIClient, createAIClientFromEnv, type ProviderRequest } from '../lib/ai/client.js';
import { AIError } from '../lib/ai/errors.js';
import { toStrictJsonSchema } from '../lib/ai/json-schema.js';
import { GeminiProvider, toGeminiJsonSchema, type FetchFn } from '../lib/ai/providers/gemini.js';
import { MOCK_FIXTURES } from '../lib/ai/providers/mock.js';
import { ResearchSchema } from '../lib/ai/schemas/research.js';

const API_KEY = 'test-gemini-key-123';
const MODEL = 'gemini-test-model';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>): FetchFn & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return Object.assign(fn, { calls });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function candidateResponse(parts: unknown[], finishReason = 'STOP'): Response {
  return jsonResponse({ candidates: [{ content: { role: 'model', parts }, finishReason }] });
}

const request: ProviderRequest = {
  systemPrompt: 'You are a research assistant.',
  userPrompt: 'Topic: Tại sao con người lại mơ?',
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  schemaName: 'research',
};

function provider(fetchFn: FetchFn, options: Partial<{ apiKey: string; model: string; timeoutMs: number }> = {}) {
  return new GeminiProvider({ apiKey: API_KEY, model: MODEL, fetch: fetchFn, ...options });
}

async function expectAIError(promise: Promise<unknown>, code: AIError['code']): Promise<AIError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AIError, `expected AIError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('expected the promise to reject');
}

function sentBody(call: RecordedCall | undefined): Record<string, unknown> {
  assert.ok(call, 'fetch was called');
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('GeminiProvider request', () => {
  test('posts to the generateContent endpoint with the API key header only', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"ok"}' }]));
    await provider(fetchFn).generateJson(request);

    const [call] = fetchFn.calls;
    assert.equal(
      call?.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent',
    );
    assert.equal(call?.init.method, 'POST');
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get('x-goog-api-key'), API_KEY);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.doesNotMatch(call?.url ?? '', new RegExp(API_KEY), 'the key is never in the URL');
    assert.ok(call?.init.signal instanceof AbortSignal, 'a timeout signal is attached');
    assert.equal(fetchFn.calls.length, 1, 'exactly one request, no retry');
  });

  test('accepts a "models/" prefixed model name', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"ok"}' }]));
    await provider(fetchFn, { model: 'models/gemini-x' }).generateJson(request);
    assert.match(fetchFn.calls[0]?.url ?? '', /\/models\/gemini-x:generateContent$/);
  });

  test('sends system instruction, user content and structured output config', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"ok"}' }]));
    await provider(fetchFn).generateJson(request);

    const body = sentBody(fetchFn.calls[0]);
    assert.deepEqual(body['systemInstruction'], { parts: [{ text: request.systemPrompt }] });
    assert.deepEqual(body['contents'], [{ role: 'user', parts: [{ text: request.userPrompt }] }]);
    assert.deepEqual(body['generationConfig'], {
      responseMimeType: 'application/json',
      responseJsonSchema: request.jsonSchema,
    });
  });
});

describe('GeminiProvider response parsing', () => {
  test('parses the JSON text of the first candidate', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"xin chào"}' }]));
    assert.deepEqual(await provider(fetchFn).generateJson(request), { answer: 'xin chào' });
  });

  test('joins multiple text parts and ignores thought parts', async () => {
    const fetchFn = fakeFetch(() =>
      candidateResponse([
        { text: 'thinking about it…', thought: true },
        { text: '{"answer":' },
        { text: '"split"}' },
      ]),
    );
    assert.deepEqual(await provider(fetchFn).generateJson(request), { answer: 'split' });
  });

  test('promptFeedback.blockReason → AI_REFUSAL', async () => {
    const fetchFn = fakeFetch(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_REFUSAL');
  });

  test('safety finish reasons → AI_REFUSAL', async () => {
    for (const reason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT']) {
      const fetchFn = fakeFetch(() => candidateResponse([], reason));
      await expectAIError(provider(fetchFn).generateJson(request), 'AI_REFUSAL');
    }
  });

  test('MAX_TOKENS → AI_INCOMPLETE (even with partial text)', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"cut' }], 'MAX_TOKENS'));
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_INCOMPLETE');
  });

  test('other non-STOP finish reasons are not accepted as success', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{"answer":"ok"}' }], 'OTHER'));
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_API_ERROR');
  });

  test('no candidates → AI_INVALID_OUTPUT', async () => {
    for (const body of [{}, { candidates: [] }]) {
      const fetchFn = fakeFetch(() => jsonResponse(body));
      const error = await expectAIError(provider(fetchFn).generateJson(request), 'AI_INVALID_OUTPUT');
      assert.match(error.message, /no candidates/);
    }
  });

  test('no text output → AI_INVALID_OUTPUT', async () => {
    const bodies = [
      { candidates: [{ finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [{ text: '   ' }] }, finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [{ text: 'only thoughts', thought: true }] }, finishReason: 'STOP' }] },
    ];
    for (const body of bodies) {
      const fetchFn = fakeFetch(() => jsonResponse(body));
      const error = await expectAIError(provider(fetchFn).generateJson(request), 'AI_INVALID_OUTPUT');
      assert.match(error.message, /no output/);
    }
  });

  test('invalid JSON text → AI_INVALID_OUTPUT', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: 'Here you go: {"answer":' }]));
    const error = await expectAIError(provider(fetchFn).generateJson(request), 'AI_INVALID_OUTPUT');
    assert.match(error.message, /not valid JSON/);
  });

  test('a non-JSON HTTP 200 body → AI_INVALID_OUTPUT', async () => {
    const fetchFn = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_INVALID_OUTPUT');
  });
});

describe('GeminiProvider errors', () => {
  const apiError = (status: number, message: string) =>
    fakeFetch(() => jsonResponse({ error: { code: status, message, status: 'ERR' } }, status));

  test('HTTP 400 → AI_API_ERROR with a safe detail', async () => {
    const leakedKey = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE123';
    const error = await expectAIError(
      provider(apiError(400, `API key not valid. Please pass a valid API key. (${leakedKey})`)).generateJson(request),
      'AI_API_ERROR',
    );
    assert.match(error.message, /HTTP 400.*API key not valid/);
    assert.doesNotMatch(error.message, /AIza/, 'key-shaped strings are redacted');
    assert.doesNotMatch(error.message, new RegExp(API_KEY));
  });

  test('HTTP 401 and 403 → AI_AUTH', async () => {
    for (const status of [401, 403]) {
      const error = await expectAIError(provider(apiError(status, 'denied')).generateJson(request), 'AI_AUTH');
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
    }
  });

  test('HTTP 429 → AI_RATE_LIMIT', async () => {
    await expectAIError(provider(apiError(429, 'Resource exhausted')).generateJson(request), 'AI_RATE_LIMIT');
  });

  test('HTTP 500 → AI_API_ERROR without echoing the body', async () => {
    const error = await expectAIError(provider(apiError(500, 'internal details')).generateJson(request), 'AI_API_ERROR');
    assert.doesNotMatch(error.message, /internal details/);
  });

  test('timeout → AI_TIMEOUT (error from fetch)', async () => {
    const fetchFn = fakeFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_TIMEOUT');
  });

  test('timeout → AI_TIMEOUT (real AbortSignal.timeout on a hanging request)', async () => {
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expectAIError(provider(hanging, { timeoutMs: 5 }).generateJson(request), 'AI_TIMEOUT');
  });

  test('network error → AI_NETWORK', async () => {
    const fetchFn = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expectAIError(provider(fetchFn).generateJson(request), 'AI_NETWORK');
  });

  test('missing GEMINI_API_KEY or GEMINI_MODEL → AI_CONFIG without calling fetch', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: '{}' }]));
    const noKey = await expectAIError(provider(fetchFn, { apiKey: '' }).generateJson(request), 'AI_CONFIG');
    assert.equal(noKey.message, 'GEMINI_API_KEY is not configured');
    const noModel = await expectAIError(provider(fetchFn, { model: '' }).generateJson(request), 'AI_CONFIG');
    assert.equal(noModel.message, 'GEMINI_MODEL is not configured');
    assert.equal(fetchFn.calls.length, 0);
  });
});

describe('Gemini JSON Schema compatibility', () => {
  function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
    if (Array.isArray(node)) {
      node.forEach((n) => collect(n, key, out));
    } else if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        if (k === key) {
          out.push(v);
        }
        collect(v, key, out);
      }
    }
    return out;
  }

  test('drops unsupported format values only and keeps the structure', () => {
    const strict = toStrictJsonSchema(ResearchSchema);
    const gemini = toGeminiJsonSchema(strict);

    assert.deepEqual(collect(strict, 'format'), ['uri']);
    assert.deepEqual(collect(gemini, 'format'), [], 'format "uri" is removed');
    for (const keyword of ['required', 'additionalProperties', 'minItems', 'maxItems', 'enum', 'type']) {
      assert.deepEqual(collect(gemini, keyword), collect(strict, keyword), `${keyword} is preserved`);
    }
    const propertyNames = (schema: unknown) =>
      collect(schema, 'properties').map((properties) => Object.keys(properties as object));
    assert.deepEqual(propertyNames(gemini), propertyNames(strict), 'every property is preserved');
    assert.equal(collect(gemini, 'items').length, collect(strict, 'items').length, 'every items schema is preserved');
  });

  test('keeps documented formats and does not treat property names as keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        format: { type: 'string', format: 'date' },
        link: { type: 'string', format: 'uri' },
      },
      required: ['format', 'link'],
      additionalProperties: false,
    };
    assert.deepEqual(toGeminiJsonSchema(schema), {
      type: 'object',
      properties: { format: { type: 'string', format: 'date' }, link: { type: 'string' } },
      required: ['format', 'link'],
      additionalProperties: false,
    });
  });
});

describe('Gemini with AIClient', () => {
  const fixtureRequest: ProviderRequest = { ...request, jsonSchema: {} };
  const validResearch = MOCK_FIXTURES['research']?.(fixtureRequest);

  test('valid Gemini output passes Zod validation', async () => {
    const fetchFn = fakeFetch(() => candidateResponse([{ text: JSON.stringify(validResearch) }]));
    const client = new AIClient(provider(fetchFn));
    const result = await client.generateStructured({
      systemPrompt: 's',
      userPrompt: 'u',
      schema: ResearchSchema,
      schemaName: 'research',
    });
    assert.deepEqual(result, validResearch);
    const body = sentBody(fetchFn.calls[0]);
    assert.doesNotMatch(JSON.stringify(body['generationConfig']), /"format"/);
  });

  test('schema-valid JSON that fails Zod is still rejected', async () => {
    const invalid = { ...(validResearch as object), sources: [{ title: 'Fake', url: 'not-a-url' }] };
    const fetchFn = fakeFetch(() => candidateResponse([{ text: JSON.stringify(invalid) }]));
    const error = await expectAIError(
      new AIClient(provider(fetchFn)).generateStructured({
        systemPrompt: 's',
        userPrompt: 'u',
        schema: ResearchSchema,
        schemaName: 'research',
      }),
      'AI_INVALID_OUTPUT',
    );
    assert.match(error.message, /sources/);
  });

  test('AI_PROVIDER=gemini selects the Gemini provider', async () => {
    const client = createAIClientFromEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: API_KEY, GEMINI_MODEL: MODEL });
    assert.ok(client.provider instanceof GeminiProvider);
    assert.equal(client.provider.name, 'gemini');
    assert.ok(createAIClientFromEnv({ AI_PROVIDER: ' Gemini ' }).provider instanceof GeminiProvider);
  });

  test('AI_PROVIDER=gemini without a key fails at call time with a clear message', async () => {
    const client = createAIClientFromEnv({ AI_PROVIDER: 'gemini', GEMINI_MODEL: MODEL });
    const error = await expectAIError(
      client.generateStructured({ systemPrompt: 's', userPrompt: 'u', schema: ResearchSchema, schemaName: 'research' }),
      'AI_CONFIG',
    );
    assert.equal(error.message, 'GEMINI_API_KEY is not configured');
  });
});
