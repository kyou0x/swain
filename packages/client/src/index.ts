export const PACKAGE_NAME = "@swain/client";

export type {
  ProjectStatusReport,
  ServerIdentity,
  StatusReport,
} from "./client.js";
export {
  authenticateOwner,
  authenticateServer,
  checkHealth,
  fetchStatus,
  healthWebAuth,
  parseStatus,
  sendOtlpJson,
} from "./client.js";
export type { Credential } from "./credentials.js";
export {
  CREDENTIAL_FORMAT,
  credentialExists,
  credentialPath,
  credentialsDir,
  discardCredential,
  loadCredential,
  originFor,
  parseCredential,
  parseOrigin,
  SLUG_RE,
  saveCredential,
} from "./credentials.js";
export type { ClientErrorCode } from "./errors.js";
export { CLIENT_ERROR_CODES, CLIENT_ERROR_MESSAGES, ClientError } from "./errors.js";
export { currentUid, ensurePrivateDir } from "./fs.js";
export { constantTimeEqual, ownerProofHex, serverProofHex } from "./hmac.js";
export type { RuntimeInfo } from "./runtime.js";
export { readRuntimeFiles, removeRuntimeFile, runtimeDir, writeRuntimeFile } from "./runtime.js";
