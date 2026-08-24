export const errorCodes = [
  "AUTH_CREDENTIALS_MISSING",
  "AUTH_CREDENTIALS_INVALID",
  "AUTH_REQUIRED",
  "AUTH_REFRESH_FAILED",
  "REMOTE_URL_INVALID",
  "REMOTE_NOT_FOUND",
  "REMOTE_FORMAT_UNSUPPORTED",
  "REMOTE_METADATA_INVALID",
  "REMOTE_BUNDLE_MISSING",
  "REMOTE_BUNDLE_CORRUPT",
  "REMOTE_CHANGED_DURING_PUSH",
  "NON_FAST_FORWARD",
  "INVALID_REF",
  "GIT_NOT_FOUND",
  "GIT_COMMAND_FAILED",
  "DRIVE_PERMISSION_DENIED",
  "DRIVE_RATE_LIMITED",
  "DRIVE_NETWORK_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class GitStorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitStorageError";
    this.code = code;
  }
}
