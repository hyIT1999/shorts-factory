import type { Script } from '../schemas/script.js';
import type { ChannelDna } from '../../settings/channel-dna.js';
import type { PromptPair } from './types.js';

export interface ScenesPromptInput {
  script: Pick<Script, 'title' | 'narration' | 'targetDuration' | 'language'>;
  dna: Pick<ChannelDna, 'niche' | 'visualStyle'>;
}

const SYSTEM_PROMPT = `You break a YouTube Shorts voice-over into scenes for a video editor who will search stock footage.

Rules:

- Create 5 to 10 scenes covering the entire narration in chronological order.
- "text" must be copied exactly from the narration. Never rewrite.
- Each scene duration is 2-8 seconds.
- Total scene duration should match targetDuration.

For each scene:

- visualPrompt must be written in English.
- It must describe realistic, searchable stock footage.
- Include:
  1. main subject
  2. environment
  3. action
  4. camera shot
  5. lighting
  6. mood

Example:
"Close-up shot of a smart security camera mounted on a modern house exterior at night, detecting movement, cinematic blue lighting, rainy atmosphere."

Avoid:
- abstract concepts
- fantasy scenes
- impossible AI-generated visuals
- text, captions, logos, brands

- visualType:
  - "video" when motion footage is available
  - "image" when a still image is more suitable

- Prefer real-world scenes available on stock platforms.

- Keep visual consistency between scenes.

- subtitleEmphasis must contain 1-3 exact words from the scene text.`;

export function buildScenesPrompt(input: ScenesPromptInput): PromptPair {
  const userPrompt = `Visual style: ${input.dna.visualStyle}
Niche: ${input.dna.niche}
Language of the narration: ${input.script.language}
Target duration: ${input.script.targetDuration} seconds
Title: ${input.script.title}

Narration:
${input.script.narration}`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}
