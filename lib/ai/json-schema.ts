import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

/**
 * Keywords that OpenAI strict structured outputs does not accept. The Zod
 * schema still enforces them when the response is validated.
 */
const UNSUPPORTED_KEYWORDS = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'default']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitize);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      // Property names are user data, not keywords: sanitize each property schema only.
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, propertySchema]) => [name, sanitize(propertySchema)]),
      );
      continue;
    }
    out[key] = sanitize(value);
  }

  // Strict mode: every object is closed and lists all its properties as required.
  if (out['type'] === 'object' && typeof out['properties'] === 'object' && out['properties'] !== null) {
    out['additionalProperties'] = false;
    out['required'] = Object.keys(out['properties']);
  }
  return out;
}

/** Converts a Zod schema into a JSON Schema usable with OpenAI strict structured outputs. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  return sanitize(z.toJSONSchema(schema, { io: 'output' })) as JsonSchema;
}
