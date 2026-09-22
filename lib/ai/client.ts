/**
 * Provider-agnostic AI client used by the workers.
 *
 * worker → AIClient (Zod validation) → AIProvider → OpenAI / Gemini / mock
 *
 * The client knows nothing about projects, videos, jobs or the database.
 * Server/worker side only: the Angular frontend must never import this.
 */
import type { z } from 'zod';
import { retryPolicyFromEnv, type RetryPolicy } from '../retry.js';
import { AIError } from './errors.js';
import { toStrictJsonSchema, type JsonSchema } from './json-schema.js';
import { GeminiProvider } from './providers/gemini.js';
import { MockAIProvider } from './providers/mock.js';
import { OpenAIProvider } from './providers/openai.js';

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: JsonSchema;
  schemaName: string;
}

/** A backend that returns JSON matching `jsonSchema` (not yet validated). */
export interface AIProvider {
  readonly name: string;
  generateJson(request: ProviderRequest): Promise<unknown>;
}

export interface StructuredRequest<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
}

const MAX_ISSUES_IN_MESSAGE = 5;

export class AIClient {
  constructor(readonly provider: AIProvider) {}

  /**
   * Requests structured output and validates it with the Zod schema.
   * Throws AIError('AI_INVALID_OUTPUT') when the output does not match.
   */
  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const raw = await this.provider.generateJson({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      jsonSchema: toStrictJsonSchema(request.schema),
      schemaName: request.schemaName,
    });

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, MAX_ISSUES_IN_MESSAGE)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new AIError('AI_INVALID_OUTPUT', `AI ${request.schemaName} output failed validation: ${issues}`);
    }
    return parsed.data;
  }
}

/** PROVIDER_RETRY_* as an AI configuration error when invalid. */
function aiRetryPolicy(env: NodeJS.ProcessEnv): RetryPolicy {
  try {
    return retryPolicyFromEnv(env);
  } catch (error) {
    throw new AIError('AI_CONFIG', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Builds the client from environment variables:
 * - AI_PROVIDER: "openai" (default), "gemini" or "mock" (deterministic fixtures, no API calls)
 * - OPENAI_API_KEY / OPENAI_MODEL for the OpenAI provider
 * - GEMINI_API_KEY / GEMINI_MODEL for the Gemini provider
 * - PROVIDER_RETRY_ATTEMPTS / PROVIDER_RETRY_BASE_MS / PROVIDER_RETRY_MAX_MS for transient failures
 */
export function createAIClientFromEnv(env: NodeJS.ProcessEnv = process.env): AIClient {
  const provider = (env['AI_PROVIDER'] ?? 'openai').trim().toLowerCase();
  if (provider === 'mock') {
    return new AIClient(new MockAIProvider());
  }
  if (provider === 'gemini') {
    return new AIClient(
      new GeminiProvider({
        apiKey: env['GEMINI_API_KEY']?.trim() ?? '',
        model: env['GEMINI_MODEL']?.trim() ?? '',
        retry: aiRetryPolicy(env),
      }),
    );
  }
  if (provider !== 'openai') {
    throw new AIError('AI_CONFIG', `Unknown AI_PROVIDER "${provider}" (use "openai", "gemini" or "mock")`);
  }
  return new AIClient(
    new OpenAIProvider({
      apiKey: env['OPENAI_API_KEY']?.trim() ?? '',
      model: env['OPENAI_MODEL']?.trim() ?? '',
      retry: aiRetryPolicy(env),
    }),
  );
}
