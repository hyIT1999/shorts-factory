import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toStrictJsonSchema, type JsonSchema } from '../lib/ai/json-schema.js';
import { MOCK_FIXTURES } from '../lib/ai/providers/mock.js';
import { ResearchSchema } from '../lib/ai/schemas/research.js';
import {
  AiScenesSchema,
  NormalizedScenesSchema,
  normalizeScenes,
  type AiScene,
} from '../lib/ai/schemas/scenes.js';
import { ScriptDraftSchema, ScriptSchema } from '../lib/ai/schemas/script.js';
import type { ProviderRequest } from '../lib/ai/client.js';

const request: ProviderRequest = { systemPrompt: '', userPrompt: 'Topic: Tại sao con người lại mơ?', jsonSchema: {}, schemaName: '' };
const fixture = (name: string) => MOCK_FIXTURES[name]?.(request) as Record<string, unknown>;

describe('ResearchSchema', () => {
  test('accepts valid research', () => {
    assert.equal(ResearchSchema.safeParse(fixture('research')).success, true);
    const withSource = { ...fixture('research'), sources: [{ title: 'Dream', url: 'https://en.wikipedia.org/wiki/Dream' }] };
    assert.equal(ResearchSchema.safeParse(withSource).success, true);
  });

  test('rejects garbage research', () => {
    const valid = fixture('research');
    const facts = valid['facts'] as Record<string, unknown>[];
    const cases: Record<string, unknown>[] = [
      { ...valid, facts: facts.slice(0, 2) },
      { ...valid, facts: [...facts, ...facts, ...facts] },
      { ...valid, summary: '' },
      { ...valid, topic: 'x'.repeat(301) },
      { ...valid, sources: [{ title: 'Fake', url: 'not a url' }] },
      { ...valid, sources: [{ title: 'Fake', url: 'javascript:alert(1)' }] },
      { ...valid, facts: [{ claim: 'a', explanation: 'b', confidence: 'certain' }, ...facts] },
      { ...valid, extra: true },
      (({ sources: _sources, ...rest }) => rest)(valid),
    ];
    for (const value of cases) {
      assert.equal(ResearchSchema.safeParse(value).success, false, JSON.stringify(value).slice(0, 120));
    }
  });
});

describe('ScriptSchema', () => {
  const draft = () => fixture('script');

  test('accepts a valid draft and stored script', () => {
    assert.equal(ScriptDraftSchema.safeParse(draft()).success, true);
    assert.equal(ScriptSchema.safeParse({ ...draft(), scenes: [], sources: [] }).success, true);
  });

  test('rejects invalid scripts', () => {
    const cases: unknown[] = [
      { ...draft(), title: 'x'.repeat(101) },
      { ...draft(), targetDuration: 20 },
      { ...draft(), targetDuration: 61 },
      { ...draft(), targetDuration: 45.5 },
      { ...draft(), hook: '' },
      { ...draft(), cta: '   ' },
    ];
    for (const value of cases) {
      assert.equal(ScriptDraftSchema.safeParse(value).success, false, JSON.stringify(value).slice(0, 120));
    }
    assert.equal(ScriptSchema.safeParse({ ...draft(), scenes: [{ text: 'x' }], sources: [] }).success, false);
    assert.equal(ScriptSchema.safeParse({ ...draft(), sources: [] }).success, false, 'scenes is required');
  });
});

describe('AiScenesSchema', () => {
  const scenes = () => (fixture('scenes')['scenes'] as AiScene[]).map((s) => ({ ...s }));

  test('accepts valid scenes', () => {
    assert.equal(AiScenesSchema.safeParse({ scenes: scenes() }).success, true);
  });

  test('rejects invalid scenes', () => {
    const tooMany = [...scenes(), ...scenes()];
    const withText = scenes();
    withText[0] = { ...withText[0]!, visualPrompt: 'a sleeping person with subtitles at the bottom' };
    const badType = scenes();
    badType[1] = { ...badType[1]!, visualType: 'animation' as 'video' };
    const cases: unknown[] = [
      { scenes: scenes().slice(0, 4) },
      { scenes: tooMany.slice(0, 11) },
      { scenes: withText },
      { scenes: badType },
      { scenes: scenes().map((s) => ({ ...s, subtitleEmphasis: ['a', 'b', 'c', 'd', 'e', 'f'] })) },
    ];
    for (const value of cases) {
      assert.equal(AiScenesSchema.safeParse(value).success, false);
    }
  });
});

describe('normalizeScenes', () => {
  const base = (durations: number[]): AiScene[] =>
    durations.map((duration, i) => ({
      index: i + 1,
      text: `Scene ${i}`,
      visualPrompt: 'a dark forest at night',
      visualType: 'video',
      subtitleEmphasis: [],
      duration,
      // Deliberately wrong AI timings: they must be ignored.
      startTime: 100 - i,
      endTime: 3,
    }));

  const total = (scenes: { duration: number }[]) => scenes.reduce((sum, s) => sum + s.duration, 0);

  test('produces sequential, non-overlapping, clamped scenes starting at 0', () => {
    const result = normalizeScenes(base([0.5, 12, 5, 6, 7]), 30);
    assert.equal(NormalizedScenesSchema.safeParse(result).success, true);
    assert.equal(result[0]?.startTime, 0);
    result.forEach((scene, i) => {
      assert.equal(scene.index, i);
      assert.ok(scene.duration >= 2 && scene.duration <= 8);
      assert.equal(scene.endTime, Math.round((scene.startTime + scene.duration) * 10) / 10);
      if (i > 0) {
        assert.equal(scene.startTime, result[i - 1]?.endTime);
      }
    });
  });

  test('scales durations toward the target duration', () => {
    const shortResult = normalizeScenes(base([3, 3, 3, 3, 3, 3, 3]), 45); // 21 s proposed
    assert.ok(Math.abs(total(shortResult) - 45) <= 4.5, `got ${total(shortResult)}`);

    const longResult = normalizeScenes(base([8, 8, 8, 8, 8, 8, 8, 8, 8, 8]), 40); // 80 s proposed
    assert.ok(Math.abs(total(longResult) - 40) <= 4, `got ${total(longResult)}`);
    assert.equal(NormalizedScenesSchema.safeParse(longResult).success, true);
  });

  test('keeps the closest total when the target is unreachable within 2–8 s', () => {
    const result = normalizeScenes(base([4, 4, 4, 4, 4]), 60); // max possible is 5 × 8 = 40
    assert.equal(total(result), 40);
    assert.equal(NormalizedScenesSchema.safeParse(result).success, true);
  });

  test('is deterministic', () => {
    const input = base([2.34, 5.67, 7.01, 3.3, 4.44, 6.5]);
    assert.deepEqual(normalizeScenes(input, 50), normalizeScenes(input, 50));
  });

  test('NormalizedScenesSchema rejects overlaps and gaps', () => {
    const good = normalizeScenes(base([4, 4, 4, 4, 4]), 20);
    const overlap = good.map((s) => ({ ...s }));
    overlap[2] = { ...overlap[2]!, startTime: overlap[2]!.startTime - 1, endTime: overlap[2]!.endTime - 1 };
    assert.equal(NormalizedScenesSchema.safeParse(overlap).success, false);
    const tooLong = good.map((s) => ({ ...s }));
    tooLong[4] = { ...tooLong[4]!, duration: 9, endTime: tooLong[4]!.startTime + 9 };
    assert.equal(NormalizedScenesSchema.safeParse(tooLong).success, false);
  });
});

describe('toStrictJsonSchema', () => {
  function walk(node: unknown, visit: (schema: JsonSchema) => void): void {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, visit));
    } else if (typeof node === 'object' && node !== null) {
      visit(node as JsonSchema);
      Object.values(node).forEach((n) => walk(n, visit));
    }
  }

  test('produces OpenAI strict-mode compatible schemas', () => {
    for (const schema of [ResearchSchema, ScriptDraftSchema, AiScenesSchema]) {
      const json = toStrictJsonSchema(schema);
      assert.equal(json['$schema'], undefined);
      walk(json, (node) => {
        assert.equal(node['minLength'], undefined);
        assert.equal(node['maxLength'], undefined);
        if (node['type'] === 'object') {
          assert.equal(node['additionalProperties'], false);
          assert.deepEqual(node['required'], Object.keys(node['properties'] as object));
        }
      });
    }
  });
});
