import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from 'openai';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { z } from 'zod';
import { AIClient, createAIClientFromEnv, type AIProvider, type ProviderRequest } from '../lib/ai/client.js';
import { AIError } from '../lib/ai/errors.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { OpenAIProvider, type ResponsesApi } from '../lib/ai/providers/openai.js';

const Schema = z.strictObject({ answer: z.string().min(1), count: z.number().int().min(1) });
const request = { systemPrompt: 'sys', userPrompt: 'user', schema: Schema, schemaName: 'demo' };

class FixedProvider implements AIProvider {
  readonly name = 'fixed';
  readonly requests: ProviderRequest[] = [];
  constructor(private readonly value: unknown) {}
  async generateJson(req: ProviderRequest): Promise<unknown> {
    this.requests.push(req);
    if (this.value instanceof Error) {
      throw this.value;
    }
    return this.value;
  }
}

async function expectAIError(promise: Promise<unknown>, code: AIError['code']): Promise<AIError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AIError, `expected AIError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('expected the promise to reject');
}

describe('AIClient', () => {
  test('returns validated data and sends a strict JSON schema', async () => {
    const provider = new FixedProvider({ answer: 'yes', count: 2 });
    const result = await new AIClient(provider).generateStructured(request);
    assert.deepEqual(result, { answer: 'yes', count: 2 });
    const [sent] = provider.requests;
    assert.equal(sent?.schemaName, 'demo');
    assert.equal(sent?.jsonSchema['additionalProperties'], false);
    assert.deepEqual(sent?.jsonSchema['required'], ['answer', 'count']);
  });

  test('rejects output that fails the Zod schema', async () => {
    const error = await expectAIError(
      new AIClient(new FixedProvider({ answer: '', count: 0 })).generateStructured(request),
      'AI_INVALID_OUTPUT',
    );
    assert.match(error.message, /demo output failed validation: answer/);
  });

  test('propagates provider errors unchanged', async () => {
    const failure = new AIError('AI_TIMEOUT', 'OpenAI request timed out');
    const error = await expectAIError(new AIClient(new FixedProvider(failure)).generateStructured(request), 'AI_TIMEOUT');
    assert.equal(error, failure);
  });
});

function response(overrides: Partial<Response>): Response {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [],
    output_text: '',
    incomplete_details: null,
    ...overrides,
  } as Response;
}

function fakeApi(result: Response | Error): ResponsesApi & { bodies: ResponseCreateParamsNonStreaming[] } {
  const bodies: ResponseCreateParamsNonStreaming[] = [];
  return {
    bodies,
    responses: {
      create: async (body) => {
        bodies.push(body);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    },
  };
}

const providerRequest: ProviderRequest = {
  systemPrompt: 'system prompt',
  userPrompt: 'user prompt',
  jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  schemaName: 'research',
};

describe('OpenAIProvider', () => {
  test('sends a strict json_schema request with the configured model and parses output_text', async () => {
    const api = fakeApi(response({ output_text: '{"answer":"ok"}' }));
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'test-model', client: api });
    assert.deepEqual(await provider.generateJson(providerRequest), { answer: 'ok' });

    const [body] = api.bodies;
    assert.equal(body?.model, 'test-model');
    assert.equal(body?.instructions, 'system prompt');
    assert.equal(body?.input, 'user prompt');
    assert.deepEqual(body?.text?.format, {
      type: 'json_schema',
      name: 'research',
      schema: providerRequest.jsonSchema,
      strict: true,
    });
  });

  test('maps refusal, incomplete and malformed responses', async () => {
    const refusal = response({
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        },
      ],
    });
    const cases: [Response, AIError['code']][] = [
      [refusal, 'AI_REFUSAL'],
      [response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'AI_INCOMPLETE'],
      [response({ status: 'failed' }), 'AI_API_ERROR'],
      [response({ output_text: '' }), 'AI_INVALID_OUTPUT'],
      [response({ output_text: 'Sure! Here is JSON: {' }), 'AI_INVALID_OUTPUT'],
    ];
    for (const [res, code] of cases) {
      const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'm', client: fakeApi(res) });
      await expectAIError(provider.generateJson(providerRequest), code);
    }
  });

  test('maps SDK errors to safe AI errors', async () => {
    const headers = new Headers();
    const cases: [Error, AIError['code']][] = [
      [new RateLimitError(429, undefined, 'Rate limit reached', headers), 'AI_RATE_LIMIT'],
      [new AuthenticationError(401, undefined, 'Incorrect API key provided: sk-abc***xyz', headers), 'AI_AUTH'],
      [new APIConnectionTimeoutError(), 'AI_TIMEOUT'],
      [new APIConnectionError({ message: 'socket hang up' }), 'AI_NETWORK'],
      [new InternalServerError(500, undefined, 'boom', headers), 'AI_API_ERROR'],
      [new BadRequestError(400, undefined, 'Invalid schema for response_format', headers), 'AI_API_ERROR'],
      [new Error('something odd'), 'AI_API_ERROR'],
    ];
    for (const [sdkError, code] of cases) {
      const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'm', client: fakeApi(sdkError) });
      const error = await expectAIError(provider.generateJson(providerRequest), code);
      assert.doesNotMatch(error.message, /sk-/, 'never leaks key material');
    }
  });

  test('fails with AI_CONFIG when the key or model is missing (no network call)', async () => {
    await expectAIError(new OpenAIProvider({ apiKey: '', model: 'm' }).generateJson(providerRequest), 'AI_CONFIG');
    await expectAIError(new OpenAIProvider({ apiKey: 'sk-test', model: '' }).generateJson(providerRequest), 'AI_CONFIG');
  });
});

describe('createAIClientFromEnv', () => {
  test('selects the provider from AI_PROVIDER', () => {
    assert.ok(createAIClientFromEnv({ AI_PROVIDER: 'mock' }).provider instanceof MockAIProvider);
    assert.ok(createAIClientFromEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'm' }).provider instanceof OpenAIProvider);
    assert.throws(() => createAIClientFromEnv({ AI_PROVIDER: 'other' }), AIError);
  });

  test('an unconfigured OpenAI client fails at call time with a clear message', async () => {
    const client = createAIClientFromEnv({});
    const error = await expectAIError(client.generateStructured(request), 'AI_CONFIG');
    assert.equal(error.message, 'OPENAI_API_KEY is not configured');
  });
});
