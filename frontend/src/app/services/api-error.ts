import { HttpErrorResponse } from '@angular/common/http';
import type { ApiErrorBody } from '../models/api';

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

/** Extracts a user-facing message from an API error response. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (isApiErrorBody(err.error)) {
      return err.error.error.message;
    }
    if (err.status === 0) {
      return 'Cannot reach the API server. Is it running on port 3000?';
    }
    return `Request failed (${err.status})`;
  }
  return 'Unexpected error';
}

/** Returns the API error code (e.g. GENERATION_ALREADY_ACTIVE), if any. */
export function apiErrorCode(err: unknown): string | null {
  return err instanceof HttpErrorResponse && isApiErrorBody(err.error) ? err.error.error.code : null;
}
