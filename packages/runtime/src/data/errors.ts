// Data layer errors

/**
 * Base error class for data layer
 */
export class DataLayerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "DataLayerError";
  }
}

/**
 * Error thrown when a session is not found
 */
export class SessionNotFoundError extends DataLayerError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND");
    this.name = "SessionNotFoundError";
  }
}

/**
 * Error thrown when queue is full
 */
export class QueueFullError extends DataLayerError {
  constructor(
    public readonly current: number,
    public readonly max: number
  ) {
    super(`Queue full: ${current}/${max}`, "QUEUE_FULL");
    this.name = "QueueFullError";
  }
}

/**
 * Error thrown when stored code is not found
 */
export class StoredCodeNotFoundError extends DataLayerError {
  constructor(name: string) {
    super(`Stored code not found: ${name}`, "STORED_CODE_NOT_FOUND");
    this.name = "StoredCodeNotFoundError";
  }
}

/**
 * Error thrown when egress handler is not found
 */
export class EgressHandlerNotFoundError extends DataLayerError {
  constructor(name: string) {
    super(`Egress handler not found: ${name}`, "EGRESS_HANDLER_NOT_FOUND");
    this.name = "EgressHandlerNotFoundError";
  }
}
