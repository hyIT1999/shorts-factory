/**
 * Unit tests for lib/voice (no database, no network).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LocalAssetStorage } from '../lib/assets/storage.js';
import { voiceCacheKey, type VoiceCacheInput } from '../lib/voice/cache.js';
import { VoiceError } from '../lib/voice/errors.js';
import { createVoiceProviderFromEnv, createVoiceServicesFromEnv } from '../lib/voice/index.js';
import { GeminiTtsProvider, type FetchFn } from '../lib/voice/providers/gemini.js';
import { MockVoiceProvider } from '../lib/voice/providers/mock.js';
import { SilentVoiceProvider, silenceWav, silentDurationSec } from '../lib/voice/providers/silent.js';
import { assertPlausibleDuration } from '../lib/voice/service.js';
import { assertVietnamese, normalizeLanguage, normalizeNarration, vietnameseMarkedRatio } from '../lib/voice/text.js';
import type { VoiceRequest } from '../lib/voice/types.js';
import { encodeWav, parseWav } from '../lib/voice/wav.js';

async function expectVoiceError(action: Promise<unknown> | (() => unknown), code: VoiceError['code']): Promise<VoiceError> {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    assert.ok(error instanceof VoiceError, `expected VoiceError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('expected a VoiceError');
}

const VI_TEXT = 'Bạn có bao giờ tự hỏi tại sao mình lại mơ không? Câu trả lời thú vị hơn bạn nghĩ rất nhiều.';

function request(overrides: Partial<VoiceRequest> = {}): VoiceRequest {
  return { text: VI_TEXT, language: 'vi', voice: 'Charon', speed: 1, style: 'Curious / mysterious', sceneIndex: 0, ...overrides };
}

describe('WAV', () => {
  test('encodes a valid PCM 16-bit mono 24 kHz WAV and parses it back', () => {
    const pcm = new Uint8Array(24_000 * 2 * 1.5); // 1.5 s
    const wav = encodeWav(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
    const info = parseWav(wav);
    assert.deepEqual(info, { sampleRate: 24_000, channels: 1, bitsPerSample: 16, dataBytes: pcm.length, durationSec: 1.5 });
  });

  test('computes duration from the real byte count (stereo, other rates)', () => {
    assert.equal(parseWav(encodeWav(new Uint8Array(44_100 * 4), { sampleRate: 44_100, channels: 2, bitsPerSample: 16 })).durationSec, 1);
    assert.equal(parseWav(silenceWav(2.5)).durationSec, 2.5);
  });

  test('skips unknown chunks before data', () => {
    const wav = encodeWav(new Uint8Array(4800), { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    assert.equal(parseWav(withList).durationSec, 0.1);
  });

  test('rejects invalid RIFF, non-PCM, wrong bit depth, missing or truncated data', async () => {
    const good = encodeWav(new Uint8Array(4800));
    const notRiff = Buffer.from(good);
    notRiff.write('RIFX', 0, 'ascii');
    const notPcm = Buffer.from(good);
    notPcm.writeUInt16LE(3, 20); // IEEE float
    const eightBit = Buffer.from(good);
    eightBit.writeUInt16LE(8, 34);
    const truncated = good.subarray(0, good.length - 100);
    const odd = encodeWav(new Uint8Array(3));
    for (const bad of [Buffer.alloc(10), notRiff, notPcm, eightBit, truncated, good.subarray(0, 36), odd, Buffer.from('not audio at all, just text')]) {
      await expectVoiceError(() => parseWav(bad), 'INVALID_AUDIO');
    }
  });
});

describe('narration text', () => {
  test('trims and collapses whitespace without changing words or punctuation', () => {
    assert.equal(normalizeNarration('  Bạn   có\n biết\t không?  '), 'Bạn có biết không?');
    assert.equal(normalizeNarration('Xin chào, thế giới!'), 'Xin chào, thế giới!');
  });

  test('preserves Vietnamese diacritics (NFC, never strips or adds marks)', () => {
    const decomposed = 'Tiếng Việt'.normalize('NFD');
    assert.equal(normalizeNarration(decomposed), 'Tiếng Việt'.normalize('NFC'));
    assert.equal(normalizeNarration(VI_TEXT), VI_TEXT);
  });

  test('language codes are normalized to the primary subtag', () => {
    assert.equal(normalizeLanguage('vi-VN'), 'vi');
    assert.equal(normalizeLanguage(' EN_us '), 'en');
  });

  test('accepts real Vietnamese and rejects unaccented narration', async () => {
    assert.ok(vietnameseMarkedRatio(VI_TEXT) > 0.5);
    assertVietnamese(VI_TEXT);
    assertVietnamese('Hãy đăng ký kênh DNA và RNA để xem thêm video khoa học mới nhé.');
    const unaccented = 'Ban co biet vi sao bach tuoc lai co toi ba trai tim khong? Loai dong vat nay rat dac biet.';
    await expectVoiceError(() => assertVietnamese(unaccented), 'TEXT_NOT_VIETNAMESE');
    await expectVoiceError(() => assertVietnamese('Have you ever wondered why humans dream every single night?'), 'TEXT_NOT_VIETNAMESE');
    assertVietnamese('OK go'); // too short to judge
  });

  test('plausible duration check rejects empty, truncated and runaway audio', async () => {
    const ok = parseWav(silenceWav(silentDurationSec(VI_TEXT)));
    assertPlausibleDuration(ok, VI_TEXT, 0, 1);
    for (const seconds of [0.1, 0.8, 120]) {
      await expectVoiceError(() => assertPlausibleDuration(parseWav(silenceWav(seconds)), VI_TEXT, 0, 1), 'INVALID_AUDIO');
    }
  });
});

describe('cache key', () => {
  const base: VoiceCacheInput = { provider: 'gemini', model: 'm', voice: 'Charon', language: 'vi', speed: 1, style: 'calm', text: VI_TEXT };

  test('is stable for the same request and changes with any input', () => {
    assert.equal(voiceCacheKey(base), voiceCacheKey({ ...base }));
    assert.match(voiceCacheKey(base), /^[0-9a-f]{64}$/);
    const variants: Partial<VoiceCacheInput>[] = [
      { text: `${VI_TEXT}!` },
      { voice: 'Kore' },
      { model: 'other' },
      { provider: 'silent' },
      { language: 'en' },
      { speed: 1.2 },
      { style: undefined },
    ];
    for (const change of variants) {
      assert.notEqual(voiceCacheKey({ ...base, ...change }), voiceCacheKey(base), JSON.stringify(change));
    }
  });
});

describe('silent and mock providers', () => {
  test('silent returns a deterministic valid WAV', async () => {
    const provider = new SilentVoiceProvider();
    const a = await provider.synthesize(request());
    const b = await provider.synthesize(request());
    assert.ok(Buffer.from(a.audio).equals(Buffer.from(b.audio)));
    assert.equal(a.mimeType, 'audio/wav');
    assert.equal(a.words, null);
    assert.equal(parseWav(a.audio).durationSec, silentDurationSec(VI_TEXT));
    assert.ok(parseWav((await provider.synthesize(request({ speed: 2 }))).audio).durationSec < parseWav(a.audio).durationSec);
  });

  test('mock controls success, duration and failure', async () => {
    const provider = new MockVoiceProvider({
      durationSec: (r) => 2 + r.sceneIndex,
      fail: (r) => (r.sceneIndex === 2 ? new VoiceError('VOICE_RATE_LIMIT', 'quota') : undefined),
    });
    assert.equal(parseWav((await provider.synthesize(request({ sceneIndex: 1 }))).audio).durationSec, 3);
    await expectVoiceError(provider.synthesize(request({ sceneIndex: 2 })), 'VOICE_RATE_LIMIT');
    assert.equal(provider.calls.length, 2);
  });
});

describe('provider factory', () => {
  test('selects providers from VOICE_PROVIDER and rejects unknown ones', async () => {
    assert.ok(createVoiceProviderFromEnv({}) instanceof GeminiTtsProvider, 'gemini is the default');
    assert.ok(createVoiceProviderFromEnv({ VOICE_PROVIDER: 'silent' }) instanceof SilentVoiceProvider);
    assert.ok(createVoiceProviderFromEnv({ VOICE_PROVIDER: ' Mock ' }) instanceof MockVoiceProvider);
    await expectVoiceError(() => createVoiceProviderFromEnv({ VOICE_PROVIDER: 'piper' }), 'VOICE_CONFIG');
  });

  test('services read model, voice and request delay from the environment', async () => {
    const storage = new LocalAssetStorage('data');
    const services = createVoiceServicesFromEnv(storage, {
      GEMINI_API_KEY: 'k',
      GEMINI_TTS_MODEL: 'gemini-tts-model',
      GEMINI_TTS_VOICE: 'Charon',
      VOICE_REQUEST_DELAY_MS: '500',
    });
    assert.equal(services.provider.model, 'gemini-tts-model');
    assert.equal(services.voice, 'Charon');
    assert.equal(services.requestDelayMs, 500);
    assert.equal(services.speed, 1);
    assert.equal(services.storage, storage, 'shares the asset storage instance');
    assert.equal(createVoiceServicesFromEnv(storage, { VOICE_PROVIDER: 'silent' }).voice, 'default');
    await expectVoiceError(() => createVoiceServicesFromEnv(storage, { VOICE_REQUEST_DELAY_MS: '-1' }), 'VOICE_CONFIG');
  });
});

describe('GeminiTtsProvider (fake fetch)', () => {
  const API_KEY = 'test-gemini-key';
  interface Call {
    url: string;
    init: RequestInit;
  }
  function fakeFetch(respond: () => Response | Promise<Response>): FetchFn & { calls: Call[] } {
    const calls: Call[] = [];
    return Object.assign(
      async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond();
      },
      { calls },
    );
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pcmSeconds = (seconds: number) => Buffer.alloc(Math.round(seconds * 24_000) * 2).toString('base64');
  const audioResponse = (data: string, mimeType = 'audio/L16;codec=pcm;rate=24000') =>
    json({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] }, finishReason: 'STOP' }], responseId: 'resp-1' });
  const provider = (fetchFn: FetchFn, overrides: { apiKey?: string; model?: string; timeoutMs?: number } = {}) =>
    new GeminiTtsProvider({ apiKey: API_KEY, model: 'gemini-tts-test', fetch: fetchFn, ...overrides });

  test('sends a generateContent AUDIO request with the configured voice and returns a WAV', async () => {
    const fetchFn = fakeFetch(() => audioResponse(pcmSeconds(2)));
    const result = await provider(fetchFn).synthesize(request());

    const [call] = fetchFn.calls;
    assert.equal(call?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-tts-test:generateContent');
    assert.equal(new Headers(call?.init.headers).get('x-goog-api-key'), API_KEY);
    assert.doesNotMatch(call?.url ?? '', new RegExp(API_KEY));
    const body = JSON.parse(String(call?.init.body)) as {
      contents: { parts: { text: string }[] }[];
      generationConfig: Record<string, unknown>;
    };
    assert.deepEqual(body.generationConfig, {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
    });
    const prompt = body.contents[0]?.parts[0]?.text ?? '';
    assert.ok(prompt.endsWith(VI_TEXT), 'the narration is sent unchanged');
    assert.match(prompt, /curious \/ mysterious tone/);

    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.words, null);
    assert.deepEqual(
      { ...parseWav(result.audio), dataBytes: undefined },
      { sampleRate: 24_000, channels: 1, bitsPerSample: 16, durationSec: 2, dataBytes: undefined },
    );
    assert.equal(result.metadata['requestId'], 'resp-1');
    assert.equal(fetchFn.calls.length, 1, 'no retry');
  });

  test('plain text without style or speed hints is sent as-is', async () => {
    const fetchFn = fakeFetch(() => audioResponse(pcmSeconds(1)));
    await provider(fetchFn).synthesize(request({ style: undefined }));
    const body = JSON.parse(String(fetchFn.calls[0]?.init.body)) as { contents: { parts: { text: string }[] }[] };
    assert.equal(body.contents[0]?.parts[0]?.text, VI_TEXT);
  });

  test('uses the sample rate from the returned mime type', async () => {
    const pcm = Buffer.alloc(16_000 * 2).toString('base64');
    const result = await provider(fakeFetch(() => audioResponse(pcm, 'audio/L16;rate=16000'))).synthesize(request());
    assert.equal(parseWav(result.audio).sampleRate, 16_000);
    assert.equal(parseWav(result.audio).durationSec, 1);
    // The format Gemini actually returns (observed): "audio/l16; rate=24000; channels=1".
    const real = await provider(fakeFetch(() => audioResponse(pcmSeconds(1), 'audio/l16; rate=24000; channels=1'))).synthesize(request());
    assert.deepEqual([parseWav(real.audio).sampleRate, parseWav(real.audio).channels, parseWav(real.audio).durationSec], [24_000, 1, 1]);
  });

  test('maps HTTP errors, timeouts and network failures', async () => {
    const cases: [() => Response, VoiceError['code'], RegExp?][] = [
      [() => json({ error: { message: 'denied' } }, 401), 'VOICE_AUTH'],
      [() => json({ error: { message: 'denied' } }, 403), 'VOICE_AUTH'],
      [() => json({ error: { message: 'Resource exhausted' } }, 429), 'VOICE_RATE_LIMIT'],
      [() => json({ error: { message: 'internal details' } }, 500), 'VOICE_API_ERROR', /\(HTTP 500\)$/],
      [() => json({ error: { message: 'Voice name Foo is not supported' } }, 400), 'VOICE_API_ERROR', /HTTP 400\): Voice name Foo/],
    ];
    for (const [respond, code, pattern] of cases) {
      const error = await expectVoiceError(provider(fakeFetch(respond)).synthesize(request()), code);
      if (pattern) {
        assert.match(error.message, pattern);
      }
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
    }
    const timeout = fakeFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expectVoiceError(provider(timeout).synthesize(request()), 'VOICE_TIMEOUT');
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expectVoiceError(provider(hanging, { timeoutMs: 5 }).synthesize(request()), 'VOICE_TIMEOUT');
    const network = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expectVoiceError(provider(network).synthesize(request()), 'VOICE_API_ERROR');
  });

  test('rejects malformed responses and missing audio', async () => {
    const cases: [() => Response, VoiceError['code']][] = [
      [() => new Response('<html>oops</html>', { status: 200 }), 'VOICE_API_ERROR'],
      [() => json({ promptFeedback: { blockReason: 'SAFETY' } }), 'VOICE_API_ERROR'],
      [() => json({ candidates: [] }), 'INVALID_AUDIO'],
      [() => json({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] }), 'INVALID_AUDIO'],
      [() => json({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), 'INVALID_AUDIO'],
      [() => audioResponse(''), 'INVALID_AUDIO'],
      [() => audioResponse(pcmSeconds(1), 'audio/mpeg'), 'INVALID_AUDIO'],
    ];
    for (const [respond, code] of cases) {
      await expectVoiceError(provider(fakeFetch(respond)).synthesize(request()), code);
    }
  });

  test('missing key, model or voice fails with VOICE_CONFIG before any request', async () => {
    const fetchFn = fakeFetch(() => audioResponse(pcmSeconds(1)));
    const noKey = await expectVoiceError(provider(fetchFn, { apiKey: '' }).synthesize(request()), 'VOICE_CONFIG');
    assert.equal(noKey.message, 'GEMINI_API_KEY is not configured');
    await expectVoiceError(provider(fetchFn, { model: '' }).synthesize(request()), 'VOICE_CONFIG');
    const noVoice = await expectVoiceError(provider(fetchFn).synthesize(request({ voice: '' })), 'VOICE_CONFIG');
    assert.equal(noVoice.message, 'GEMINI_TTS_VOICE is not configured');
    assert.equal(fetchFn.calls.length, 0);
  });
});
