/**
 * Gemini provider: calls the Gemini REST API (generateContent) with native
 * fetch and structured output (responseMimeType + responseJsonSchema).
 * No SDK. Transient failures (HTTP 429, 5xx, timeouts, network errors) are
 * retried according to the injected RetryPolicy (no retry when the provider
 * is constructed directly); every failure becomes an AIError.
 */
import {
  isRetryableHttpStatus,
  NO_RETRY,
  parseGoogleDuration,
  parseRetryAfterHeader,
  withRetry,
  type RetryPolicy,
} from '../../retry.js';
import type { AIProvider, ProviderRequest } from '../client.js';
import { AIError } from '../errors.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DETAIL_LENGTH = 200;

/** Gemini structured output only documents these string formats. */
const SUPPORTED_FORMATS = new Set(['date-time', 'date', 'time']);

/** Finish reasons meaning the model declined or was blocked. */
const REFUSAL_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** Injected fetch for tests. Defaults to the global fetch. */
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Retry policy for transient failures (default: a single request). */
  retry?: RetryPolicy;
  /** Injected for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Where retries are reported (default: console.warn). */
  log?: (message: string) => void;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Adapts the shared strict JSON Schema to what Gemini supports. Everything is
 * kept (type, properties, required, additionalProperties, items, enum,
 * min/maxItems, minimum/maximum) except `format` values Gemini does not
 * document (e.g. "uri"); Zod still validates those fields afterwards.
 */
export function toGeminiJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(toGeminiJsonSchema);
  }
  if (!isObject(node)) {
    return node;
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'format' && !(typeof value === 'string' && SUPPORTED_FORMATS.has(value))) {
      continue;
    }
    if (key === 'properties' && isObject(value)) {
      // Property names are data, not keywords.
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, toGeminiJsonSchema(schema)]),
      );
      continue;
    }
    out[key] = toGeminiJsonSchema(value);
  }
  return out;
}

/** Keeps error details short and never echoes anything shaped like a Google API key. */
function safeDetail(message: string): string {
  return message.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]').slice(0, MAX_DETAIL_LENGTH);
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly log: (message: string) => void;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model.replace(/^models\//, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? NO_RETRY;
    this.sleep = options.sleep;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  async generateJson(request: ProviderRequest): Promise<unknown> {
    if (!this.apiKey) {
      throw new AIError('AI_CONFIG', 'GEMINI_API_KEY is not configured');
    }
    if (!this.model) {
      throw new AIError('AI_CONFIG', 'GEMINI_MODEL is not configured');
    }
    return withRetry(() => this.attempt(request), {
      policy: this.retry,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      onRetry: ({ attempt, attempts, delayMs, error }) =>
        this.log(
          `Gemini ${request.schemaName}: ${error instanceof Error ? error.message : String(error)}; ` +
            `retry ${attempt} of ${attempts - 1} in ${Math.round(delayMs / 1000)} s`,
        ),
    });
  }

  /** One generateContent request; throws an AIError that says whether it is worth retrying. */
  private async attempt(request: ProviderRequest): Promise<unknown> {
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiJsonSchema(request.jsonSchema),
      },
    };

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      payload = await readJson(response);
    } catch (error) {
      throw toNetworkError(error);
    }

    if (!response.ok) {
      throw httpError(response.status, payload, response.headers);
    }
    return extractJson(payload, request.schemaName);
  }
}

/** Reads a JSON body; a non-JSON body becomes `undefined` (handled by the caller). */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toNetworkError(error: unknown): AIError {
  if (error instanceof AIError) {
    return error;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new AIError('AI_TIMEOUT', 'Gemini request timed out', { retryable: true });
  }
  return new AIError('AI_NETWORK', 'Could not reach the Gemini API (network error)', { retryable: true });
}

/** Google's RetryInfo detail ("retryDelay": "12s") that accompanies quota errors. */
function googleRetryDelay(payload: unknown): number | undefined {
  const error = isObject(payload) && isObject(payload['error']) ? payload['error'] : undefined;
  const details = Array.isArray(error?.['details']) ? error['details'] : [];
  for (const detail of details) {
    const ms = isObject(detail) ? parseGoogleDuration(detail['retryDelay']) : undefined;
    if (ms !== undefined) {
      return ms;
    }
  }
  return undefined;
}

function httpError(status: number, payload: unknown, headers?: Headers): AIError {
  const error = isObject(payload) && isObject(payload['error']) ? payload['error'] : undefined;
  const message = typeof error?.['message'] === 'string' ? error['message'] : '';
  const detail = message ? `: ${safeDetail(message)}` : '';
  const retryAfterMs = parseRetryAfterHeader(headers?.get('retry-after')) ?? googleRetryDelay(payload);

  if (status === 401 || status === 403) {
    return new AIError('AI_AUTH', `Gemini rejected the credentials (HTTP ${status}); check GEMINI_API_KEY`);
  }
  if (status === 429) {
    return new AIError('AI_RATE_LIMIT', 'Gemini rate limit or quota exceeded (HTTP 429)', { retryable: true, retryAfterMs });
  }
  // 400/404 explain misconfiguration (invalid key, unknown model, rejected schema).
  const withDetail = status === 400 || status === 404 ? detail : '';
  return new AIError('AI_API_ERROR', `Gemini API error (HTTP ${status})${withDetail}`, {
    retryable: isRetryableHttpStatus(status),
    retryAfterMs,
  });
}

function extractJson(payload: unknown, schemaName: string): unknown {
  if (!isObject(payload)) {
    throw new AIError('AI_INVALID_OUTPUT', `Gemini ${schemaName} response was not valid JSON`);
  }

  const feedback = payload['promptFeedback'];
  if (isObject(feedback) && typeof feedback['blockReason'] === 'string') {
    throw new AIError('AI_REFUSAL', `Gemini blocked the ${schemaName} request (${feedback['blockReason']})`);
  }

  const candidates = payload['candidates'];
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!isObject(candidate)) {
    throw new AIError('AI_INVALID_OUTPUT', `Gemini ${schemaName} response contained no candidates`);
  }

  const finishReason = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : 'unknown';
  if (finishReason === 'MAX_TOKENS') {
    throw new AIError('AI_INCOMPLETE', `Gemini ${schemaName} response was incomplete (MAX_TOKENS)`);
  }
  if (REFUSAL_FINISH_REASONS.has(finishReason)) {
    throw new AIError('AI_REFUSAL', `Gemini refused to generate ${schemaName} (${finishReason})`);
  }
  if (finishReason !== 'STOP') {
    throw new AIError('AI_API_ERROR', `Gemini ${schemaName} response finished with "${finishReason}"`);
  }

  const content = candidate['content'];
  const parts = isObject(content) && Array.isArray(content['parts']) ? content['parts'] : [];
  const text = parts
    .filter((part): part is JsonObject => isObject(part) && part['thought'] !== true)
    .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    .join('');
  if (!text.trim()) {
    throw new AIError('AI_INVALID_OUTPUT', `Gemini ${schemaName} response contained no output`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AIError('AI_INVALID_OUTPUT', `Gemini ${schemaName} response was not valid JSON`);
  }
}
