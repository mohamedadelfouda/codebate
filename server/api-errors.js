import { redact } from "./logger.js";

export function apiErrorPayload(code, error, extra = {}) {
  const detail = redact(error instanceof Error ? error.message : String(error));
  return { ...extra, code, error: detail, detail };
}

export function expectedApiError(code, message, status = 409) {
  const error = new Error(message);
  error.apiCode = code;
  error.apiStatus = status;
  return error;
}
