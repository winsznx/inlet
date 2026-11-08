export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "UNSUPPORTED_FORM"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "SANDBOX_UNAVAILABLE"
  | "DESTINATION_UNAVAILABLE"
  | "INFERENCE_NOT_CONFIGURED"
  | "UNSAFE_TARGET"
  | "OWNERSHIP_NOT_VERIFIED"
  | "DESTINATION_REQUIRED"
  | "REPOSITORY_REQUIRED"
  | "SUBMISSION_ALREADY_EXECUTED"
  | "CSRF_REJECTED"
  | "SIGNATURE_INVALID"
  | "PATCH_GUARD_FAILED"
  | "GITHUB_NOT_CONFIGURED"
  | "BASE_MOVED"
  | "INTERNAL";

const statusByCode: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  SIGNATURE_INVALID: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  SUBMISSION_ALREADY_EXECUTED: 409,
  BASE_MOVED: 409,
  UNSUPPORTED_FORM: 422,
  UNSAFE_TARGET: 422,
  OWNERSHIP_NOT_VERIFIED: 422,
  DESTINATION_REQUIRED: 422,
  REPOSITORY_REQUIRED: 422,
  PATCH_GUARD_FAILED: 422,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  SANDBOX_UNAVAILABLE: 503,
  DESTINATION_UNAVAILABLE: 503,
  INFERENCE_NOT_CONFIGURED: 503,
  GITHUB_NOT_CONFIGURED: 503,
  INTERNAL: 500,
};

const retryableCodes = new Set<ErrorCode>([
  "RATE_LIMITED",
  "DEPENDENCY_UNAVAILABLE",
  "SANDBOX_UNAVAILABLE",
  "DESTINATION_UNAVAILABLE",
  "INTERNAL",
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly nextAction?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { nextAction?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.nextAction = options?.nextAction;
    this.details = options?.details;
  }

  get status(): number {
    return statusByCode[this.code];
  }

  get retryable(): boolean {
    return retryableCodes.has(this.code);
  }
}

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    nextAction?: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};
