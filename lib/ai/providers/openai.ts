import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import { isRetryableHttpStatus, NO_RETRY, parseRetryAfterHeader, withRetry, type RetryPolicy } from '../../retry.js';
import type { AIProvider, ProviderRequest } from '../client.js';
import { AIError } from '../errors.js';

/** The part of the OpenAI SDK this provider uses (lets tests inject a fake). */
export interface ResponsesApi {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<Response>;
  };
}

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** Injected client for tests. Defaults to the official SDK client. */
  client?: ResponsesApi;
  timeoutMs?: number;
  /** Retry policy for transient failures (default: a single request). */
  retry?: RetryPolicy;
  /** Injected for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Where retries are reported (default: console.warn). */
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DETAIL_LENGTH = 200;

/** Calls the OpenAI Responses API with strict JSON Schema structured output. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly log: (message: string) => void;
  private client: ResponsesApi | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.client = options.client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? NO_RETRY;
    this.sleep = options.sleep;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  async generateJson(request: ProviderRequest): Promise<unknown> {
    const client = this.getClient();

    const response = await withRetry(
      async () => {
        try {
          return await client.responses.create({
            model: this.model,
            instructions: request.systemPrompt,
            input: request.userPrompt,
            text: {
              format: {
                type: 'json_schema',
                name: request.schemaName,
                schema: request.jsonSchema,
                strict: true,
              },
            },
          });
        } catch (error) {
          throw toAIError(error);
        }
      },
      {
        policy: this.retry,
        ...(this.sleep ? { sleep: this.sleep } : {}),
        onRetry: ({ attempt, attempts, delayMs, error }) =>
          this.log(
            `OpenAI ${request.schemaName}: ${error instanceof Error ? error.message : String(error)}; ` +
              `retry ${attempt} of ${attempts - 1} in ${Math.round(delayMs / 1000)} s`,
          ),
      },
    );

    return extractJson(response, request.schemaName);
  }

  private getClient(): ResponsesApi {
    if (this.client) {
      return this.client;
    }
    if (!this.apiKey) {
      throw new AIError('AI_CONFIG', 'OPENAI_API_KEY is not configured');
    }
    if (!this.model) {
      throw new AIError('AI_CONFIG', 'OPENAI_MODEL is not configured');
    }
    // Retries are handled here (lib/retry.ts), not by the SDK.
    this.client = new OpenAI({ apiKey: this.apiKey, maxRetries: 0, timeout: this.timeoutMs });
    return this.client;
  }
}

function extractJson(response: Response, schemaName: string): unknown {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new AIError('AI_INCOMPLETE', `AI ${schemaName} response was incomplete (${reason})`);
  }
  if (response.status && response.status !== 'completed') {
    throw new AIError('AI_API_ERROR', `AI ${schemaName} response ended with status "${response.status}"`);
  }

  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'refusal') {
          throw new AIError('AI_REFUSAL', `AI refused to generate ${schemaName}`);
        }
      }
    }
  }

  const text = response.output_text;
  if (!text) {
    throw new AIError('AI_INVALID_OUTPUT', `AI ${schemaName} response contained no output`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AIError('AI_INVALID_OUTPUT', `AI ${schemaName} response was not valid JSON`);
  }
}

/** The Retry-After header of an SDK error, whichever shape the SDK gives the headers. */
function retryAfterOf(error: APIError): number | undefined {
  const headers: unknown = error.headers;
  let value: unknown;
  if (headers instanceof Headers) {
    value = headers.get('retry-after');
  } else if (typeof headers === 'object' && headers !== null) {
    value = (headers as Record<string, unknown>)['retry-after'];
  }
  return parseRetryAfterHeader(typeof value === 'string' ? value : null);
}

/** Maps SDK errors to safe AIErrors (no raw payloads, no credentials). */
export function toAIError(error: unknown): AIError {
  if (error instanceof AIError) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AIError('AI_TIMEOUT', 'OpenAI request timed out', { retryable: true });
  }
  if (error instanceof APIConnectionError) {
    return new AIError('AI_NETWORK', 'Could not reach the OpenAI API (network error)', { retryable: true });
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new AIError('AI_AUTH', `OpenAI rejected the credentials (HTTP ${error.status}); check OPENAI_API_KEY`);
  }
  if (error instanceof RateLimitError) {
    return new AIError('AI_RATE_LIMIT', 'OpenAI rate limit or quota exceeded (HTTP 429)', {
      retryable: true,
      retryAfterMs: retryAfterOf(error),
    });
  }
  if (error instanceof APIError) {
    const requestId = error.requestID ? `, request ${error.requestID}` : '';
    // 400/404 explain misconfiguration (unknown model, rejected schema) and carry no credentials.
    const detail =
      (error.status === 400 || error.status === 404) && error.message
        ? `: ${error.message.slice(0, MAX_DETAIL_LENGTH)}`
        : '';
    return new AIError('AI_API_ERROR', `OpenAI API error (HTTP ${error.status ?? 'unknown'}${requestId})${detail}`, {
      retryable: error.status !== undefined && isRetryableHttpStatus(error.status),
      retryAfterMs: retryAfterOf(error),
    });
  }
  return new AIError('AI_API_ERROR', 'Unexpected error while calling OpenAI');
}
