/**
 * Deterministic visualPrompt → stock search query (no AI call).
 * Drops filler words and camera/style vocabulary, keeping the subject keywords.
 */
import type { AssetKind, AssetQuery } from './types.js';

export const MAX_KEYWORDS = 6;

const STOPWORDS = new Set(
  'a an the of in on at to for from with without by and or but as into onto over under through its it is are be of this that these those some very'.split(' '),
);

/** Visual style / camera words that describe *how* to shoot, not *what* to find. */
const STYLE_WORDS = new Set(
  (
    'cinematic cinema film filmic shot shots close up closeup extreme wide medium macro aerial drone pov angle view ' +
    'slow motion timelapse time lapse lapse footage video image photo photograph still b-roll broll clip ' +
    'lighting light lit low key high moody mood dramatic dark ominous mysterious atmosphere atmospheric vibe tone tones ' +
    'documentary style styled aesthetic cinematic look looking subtle soft hard glowing glow shadows shadowy ' +
    'hd 4k 8k uhd hdr realistic photorealistic hyperrealistic detailed high-quality quality beautiful stunning epic ' +
    'camera push pull pan tracking dolly zoom focus depth bokeh background foreground scene'
  ).split(' '),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, ''))
    .filter((word) => word.length > 1);
}

const isFiller = (word: string): boolean => STOPWORDS.has(word) || STYLE_WORDS.has(word) || /^\d+$/.test(word);

/** Extracts up to MAX_KEYWORDS subject keywords from a visual prompt, in order of appearance. */
export function extractKeywords(visualPrompt: string): string[] {
  const keywords: string[] = [];
  for (const word of tokenize(visualPrompt)) {
    // "close-up", "slow-motion", "time-lapse": filler when every part is filler.
    if (isFiller(word) || word.split('-').every(isFiller) || keywords.includes(word)) {
      continue;
    }
    keywords.push(word);
    if (keywords.length === MAX_KEYWORDS) {
      break;
    }
  }
  return keywords;
}

export interface SceneForQuery {
  index: number;
  duration: number | null;
  visualPrompt: string | null;
  visualType: string | null;
}

export function buildAssetQuery(scene: SceneForQuery): AssetQuery {
  const visualPrompt = scene.visualPrompt?.trim() ?? '';
  const keywords = extractKeywords(visualPrompt);
  const preferredKind: AssetKind = scene.visualType === 'image' ? 'image' : 'video';
  return {
    sceneIndex: scene.index,
    preferredKind,
    keywords,
    text: keywords.join(' '),
    visualPrompt,
    minDurationSec: scene.duration ?? 0,
    orientation: 'portrait',
    width: 1080,
    height: 1920,
  };
}
