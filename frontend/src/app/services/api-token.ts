import type { HttpInterceptorFn } from '@angular/common/http';

/**
 * Optional API token (only needed when the server is started with API_TOKEN).
 * It is kept in this browser's localStorage and never sent anywhere but the
 * /api requests of this app.
 */
export const API_TOKEN_STORAGE_KEY = 'shortsFactory.apiToken';

export function getApiToken(): string {
  try {
    return localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setApiToken(token: string): void {
  try {
    if (token.trim()) {
      localStorage.setItem(API_TOKEN_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode): the token simply is not remembered.
  }
}

/** Adds `Authorization: Bearer …` to /api requests when a token is stored. */
export const apiTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const token = getApiToken();
  if (!token || !req.url.startsWith('/api')) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};

/**
 * For resources the browser loads itself (<video src>, download links), which
 * cannot carry headers: the server accepts the token as a query parameter on
 * the video output route only.
 */
export function withApiToken(url: string): string {
  const token = getApiToken();
  if (!token) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
