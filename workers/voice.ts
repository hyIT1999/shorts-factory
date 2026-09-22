/**
 * VOICE stage: one narration WAV per scene via the configured VoiceProvider
 * (Gemini TTS by default) — by default one TTS request for the whole video,
 * cut at the pauses (VOICE_MODE=narration) — then scene timings and
 * Video.duration are rebuilt from the real audio. See lib/voice/service.ts.
 */
import type { JobHandler } from '../lib/jobs/types.js';
import { synthesizeVideoVoice } from '../lib/voice/service.js';
import type { VoiceJobResult } from '../lib/voice/types.js';

export const voiceHandler: JobHandler = async (_job, payload, { voice }): Promise<VoiceJobResult> =>
  synthesizeVideoVoice({ projectId: payload.projectId, videoId: payload.videoId }, voice);
