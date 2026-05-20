// HTTP Response Utilities
// Consolidated JSON response handling for Worker routes

export interface JsonResponseInit extends ResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Create a JSON response with proper headers
 */
export function json(data: unknown, init: JsonResponseInit = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...init.headers,
  };

  const body = JSON.stringify(data, null, typeof init.status === "number" && init.status >= 400 ? undefined : undefined);

  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}

/**
 * Create an error JSON response
 */
export function errorJson(
  message: string,
  status: number,
  extra?: Record<string, unknown>
): Response {
  const body: Record<string, unknown> = { error: message, ...extra };
  return json(body, { status });
}

/**
 * 404 Not Found response
 */
export function notFound(resource?: string): Response {
  const message = resource ? `${resource} not found` : "Not found";
  return errorJson(message, 404);
}

/**
 * 400 Bad Request response
 */
export function badRequest(message: string, details?: Record<string, unknown>): Response {
  return errorJson(message, 400, details);
}

/**
 * 401 Unauthorized response
 */
export function unauthorized(message: string = "Unauthorized"): Response {
  return errorJson(message, 401);
}

/**
 * 403 Forbidden response
 */
export function forbidden(message: string = "Forbidden"): Response {
  return errorJson(message, 403);
}

/**
 * 410 Gone response (session closed)
 */
export function gone(message: string): Response {
  return errorJson(message, 410);
}

/**
 * 429 Too Many Requests response
 */
export function tooManyRequests(message: string, extra?: Record<string, unknown>): Response {
  return errorJson(message, 429, extra);
}

/**
 * 500 Internal Server Error response
 */
export function serverError(message: string = "Internal server error"): Response {
  return errorJson(message, 500);
}

/**
 * 503 Service Unavailable response
 */
export function serviceUnavailable(message: string = "Service unavailable"): Response {
  return errorJson(message, 503);
}

/**
 * 413 Payload Too Large response (with storage quota details)
 */
export function payloadTooLarge(details: {
  requestedSize: number;
  limit: number;
  key: string;
  messageSize: number;
  messageCount: number;
  suggestedAction: string;
}): Response {
  return errorJson("Session storage limit exceeded", 413, {
    details,
    hint: details.suggestedAction,
  });
}
