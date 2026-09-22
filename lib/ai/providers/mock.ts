/**
 * Deterministic AI provider for tests and credit-free development
 * (AI_PROVIDER=mock). Returns fixed, schema-valid fixtures per schema name.
 * Its output still goes through the same Zod validation as real AI output.
 */
import type { AIProvider, ProviderRequest } from '../client.js';

/** A fixed JSON value, or a function computing (or throwing) the response. */
export type MockResponse = ((request: ProviderRequest) => unknown) | Record<string, unknown> | unknown[];

function topicFrom(request: ProviderRequest): string {
  const line = request.userPrompt.split('\n').find((l) => l.startsWith('Topic: '));
  return line ? line.slice('Topic: '.length).trim() : 'Tại sao con người lại mơ?';
}

export const MOCK_FIXTURES: Record<string, (request: ProviderRequest) => unknown> = {
  research: (request) => ({
    topic: topicFrom(request),
    summary: 'Giấc mơ chủ yếu xuất hiện trong giai đoạn ngủ REM; khoa học có nhiều giả thuyết về chức năng của chúng.',
    hookFact: 'Khi bạn mơ, não hoạt động mạnh gần như lúc thức trong khi cơ thể gần như tê liệt.',
    facts: [
      {
        claim: 'Phần lớn giấc mơ sống động xảy ra trong giấc ngủ REM.',
        explanation: 'Trong REM, não hoạt động mạnh gần giống lúc thức trong khi cơ thể gần như bất động.',
        confidence: 'established',
        visualIdea: 'Close-up of a sleeping person with eyes moving under closed eyelids in a dark bedroom.',
      },
      {
        claim: 'Mỗi đêm chúng ta trải qua nhiều chu kỳ REM.',
        explanation: 'Một chu kỳ ngủ kéo dài khoảng 90 phút và giai đoạn REM dài dần về sáng.',
        confidence: 'established',
        visualIdea: 'Time-lapse of a bedroom window from night to dawn while a person sleeps.',
      },
      {
        claim: 'Giấc mơ có thể giúp củng cố trí nhớ.',
        explanation: 'Một số nghiên cứu cho thấy não xử lý lại trải nghiệm trong ngày khi ngủ, nhưng cơ chế vẫn đang được tranh luận.',
        confidence: 'debated',
        visualIdea: 'Researcher watching brain activity on monitors in a sleep laboratory.',
      },
    ],
    curiosityScore: 8,
    visualScore: 6,
    sources: [],
  }),
  script: () => ({
    title: 'Tại sao chúng ta lại mơ?',
    hook: 'Bạn có bao giờ tự hỏi tại sao mình lại mơ không?',
    narration:
      'Bạn có bao giờ tự hỏi tại sao mình lại mơ không? Mỗi đêm, não bạn trải qua nhiều chu kỳ ngủ. ' +
      'Trong giai đoạn REM, não hoạt động gần như lúc bạn thức. Đó là lúc những giấc mơ sống động nhất xuất hiện. ' +
      'Nhiều nhà khoa học cho rằng giấc mơ giúp não sắp xếp lại ký ức. Nhưng đến nay, đó vẫn là một giả thuyết. ' +
      'Theo dõi kênh để khám phá thêm bí ẩn của bộ não.',
    language: 'vi',
    targetDuration: 45,
    cta: 'Theo dõi kênh để khám phá thêm bí ẩn của bộ não.',
  }),
  scenes: () => ({
    scenes: [
      { text: 'Bạn có bao giờ tự hỏi tại sao mình lại mơ không?', visualPrompt: 'cinematic close-up of a person sleeping at night, soft moonlight, dark documentary mood', visualType: 'video', subtitleEmphasis: ['tại sao', 'mơ'], duration: 4 },
      { text: 'Mỗi đêm, não bạn trải qua nhiều chu kỳ ngủ.', visualPrompt: 'time-lapse of a dark bedroom as night passes, slow camera push', visualType: 'video', subtitleEmphasis: ['chu kỳ ngủ'], duration: 5 },
      { text: 'Trong giai đoạn REM, não hoạt động gần như lúc bạn thức.', visualPrompt: 'glowing neural network pulses inside a human brain, dark background', visualType: 'video', subtitleEmphasis: ['REM'], duration: 6 },
      { text: 'Đó là lúc những giấc mơ sống động nhất xuất hiện.', visualPrompt: 'surreal dreamlike clouds drifting in slow motion, deep blue tones', visualType: 'video', subtitleEmphasis: ['sống động'], duration: 5 },
      { text: 'Nhiều nhà khoa học cho rằng giấc mơ giúp não sắp xếp lại ký ức.', visualPrompt: 'scientist examining brain scans on a monitor in a dim laboratory', visualType: 'image', subtitleEmphasis: ['ký ức'], duration: 7 },
      { text: 'Nhưng đến nay, đó vẫn là một giả thuyết.', visualPrompt: 'silhouette of a person looking at a starry night sky, contemplative', visualType: 'video', subtitleEmphasis: ['giả thuyết'], duration: 4 },
      { text: 'Theo dõi kênh để khám phá thêm bí ẩn của bộ não.', visualPrompt: 'slow zoom into a glowing brain model on a dark table', visualType: 'video', subtitleEmphasis: ['bí ẩn'], duration: 5 },
    ].map((scene, index) => ({ index, startTime: 0, endTime: 0, ...scene })),
  }),
};

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  readonly calls: ProviderRequest[] = [];

  /** `overrides` replaces the fixture for a schema name with a value or function (e.g. one that throws). */
  constructor(private readonly overrides: Record<string, MockResponse> = {}) {}

  async generateJson(request: ProviderRequest): Promise<unknown> {
    this.calls.push(request);
    const override = this.overrides[request.schemaName];
    const response = override !== undefined ? override : MOCK_FIXTURES[request.schemaName];
    if (response === undefined) {
      throw new Error(`MockAIProvider has no fixture for "${request.schemaName}"`);
    }
    return typeof response === 'function' ? response(request) : response;
  }
}
