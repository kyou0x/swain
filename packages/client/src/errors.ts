/**
 * Typed client errors. Every message is static: no path, URL, header, key or response text is ever
 * placed in an error (SPEC-003 section 4: every message is static or escaped).
 */
export const CLIENT_ERROR_CODES = [
  /** Exit 8: nothing answered, or the answer was not HTTP/JSON in the expected shape. */
  "server-unreachable",
  /** Exit 8: the server could not prove it holds the key's proof key. No key was sent. */
  "server-unauthenticated",
  /** Exit 9: the server answered with a refusal. */
  "server-rejected",
  /** Exit 2: the requested server origin differs from the credential's recorded origin. */
  "credential-origin-mismatch",
  "credential-invalid",
  "credential-missing",
  "credential-exists",
  "credential-unsafe",
  "invalid-origin",
  "unsafe-directory",
  "io",
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export const CLIENT_ERROR_MESSAGES: Readonly<Record<ClientErrorCode, string>> = {
  "server-unreachable": "the server did not answer as expected",
  "server-unauthenticated":
    "the server could not prove it is the server that issued this credential; no key was sent",
  "server-rejected": "the server refused the request",
  "credential-origin-mismatch":
    "the requested server differs from the origin recorded in the credential file",
  "credential-invalid": "the credential file is malformed",
  "credential-missing": "no credential file exists for this project",
  "credential-exists": "a credential file already exists at the target path",
  "credential-unsafe": "the credential file or its directory has unsafe permissions or type",
  "invalid-origin": "the server origin must be http://127.0.0.1:<port> or http://[::1]:<port>",
  "unsafe-directory": "a swain directory is a symlink, not owned by you, or writable by others",
  io: "filesystem or network error",
};

export class ClientError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode) {
    super(code);
    this.name = "ClientError";
    this.code = code;
  }
}
