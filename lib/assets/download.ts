/**
 * Safe remote download for stock providers (used from Phase B on).
 * Only https URLs on allow-listed hosts, image/video content types and a size
 * limit are accepted. Returns a stream to hand to LocalAssetStorage.writeAtomic
 * (which enforces the size limit again while streaming).
 */
import { AssetError } from './types.js';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenRemoteOptions {
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
  fetch?: FetchFn;
}

export interface RemoteBody {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  contentLength: number | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export async function openRemote(url: string, options: OpenRemoteOptions): Promise<RemoteBody> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AssetError('DOWNLOAD_FAILED', 'Invalid asset URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new AssetError('DOWNLOAD_FAILED', `Only https downloads are allowed (got ${parsed.protocol})`);
  }
  if (!hostAllowed(parsed.hostname, options.allowedHosts)) {
    throw new AssetError('DOWNLOAD_FAILED', `Host not allowed: ${parsed.hostname}`);
  }

  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchFn(parsed.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new AssetError('DOWNLOAD_FAILED', timedOut ? 'Asset download timed out' : 'Asset download failed (network error)');
  }

  if (!response.ok || !response.body) {
    throw new AssetError('DOWNLOAD_FAILED', `Asset download failed (HTTP ${response.status})`);
  }
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^(image|video)\//.test(mimeType)) {
    await response.body.cancel();
    throw new AssetError('DOWNLOAD_FAILED', `Unexpected content type "${mimeType || 'none'}"`);
  }
  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (contentLength !== null && contentLength > options.maxBytes) {
    await response.body.cancel();
    throw new AssetError('DOWNLOAD_FAILED', `Asset is too large (${contentLength} bytes)`);
  }

  return { body: response.body, mimeType, contentLength };
}
