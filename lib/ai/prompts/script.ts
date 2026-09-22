import type { Research } from '../schemas/research.js';
import type { ChannelDna } from '../../settings/channel-dna.js';
import type { PromptPair } from './types.js';

export interface ScriptPromptInput {
  topic: string;
  research: Pick<Research, 'summary' | 'facts'>;
  dna: Pick<ChannelDna, 'language' | 'niche' | 'targetAudience' | 'tone' | 'hookStyle' | 'ctaStyle'>;
  duration: { min: number; max: number };
}

const SYSTEM_PROMPT = `You write voice-over scripts for YouTube Shorts (vertical, under 60 seconds).
This is spoken audio, not an article.

Rules:
- Open with a strong hook in the first sentence (follow the requested hook style). No greetings, no "in this video", no slow introductions.
- Short, simple, spoken-language sentences that are easy to read aloud. Reveal information step by step and keep curiosity high.
- Use ONLY claims supported by the research provided. Present "debated" facts as hypotheses, never as certainties. No clickbait that contradicts the facts.
- Avoid filler, lists of dates and academic phrasing.
- End with one short call to action in the requested CTA style.
- "narration" is the complete voice-over from hook to CTA exactly as it will be read. "hook" and "cta" repeat its first and last sentences.
- Size the narration for the target duration (about 2.5 spoken words per second) and set "targetDuration" in seconds.
- Write everything in the requested language.

Bad opening (article style): "Trong lịch sử tiến hóa của nhân loại, hiện tượng giấc mơ đã được nghiên cứu..."
Good opening (Shorts style): "Bạn có bao giờ tự hỏi tại sao mình lại mơ không?"

Additional Shorts optimization rules:

- Design the narration for viewer retention, not just information delivery.
- Follow this structure:
  * First 10%: curiosity hook
  * Middle 80%: progressive reveal
  * Final 10%: conclusion and CTA

- Introduce a new idea, fact, or visual change every 5-8 seconds.

- Prefer concrete descriptions that can be represented visually with stock footage or images.
Avoid abstract explanations that cannot be shown on screen.

- Hook must create an immediate curiosity gap using:
  surprise, question, unexpected fact, or contradiction.

- CTA should encourage interaction, not just "subscribe".`;

export function buildScriptPrompt(input: ScriptPromptInput): PromptPair {
  const facts = input.research.facts
    .map((fact) => `- [${fact.confidence}] ${fact.claim} — ${fact.explanation}`)
    .join('\n');

  const userPrompt = `Topic: ${input.topic}

Channel:
- Language: ${input.dna.language}
- Niche: ${input.dna.niche}
- Audience: ${input.dna.targetAudience}
- Tone: ${input.dna.tone}
- Hook style: ${input.dna.hookStyle}
- CTA style: ${input.dna.ctaStyle}
- Target duration: ${input.duration.min}-${input.duration.max} seconds

Research summary:
${input.research.summary}

Facts:
${facts}`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}
