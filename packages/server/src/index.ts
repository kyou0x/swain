export const PACKAGE_NAME = "@swain/server";

export type { LoopbackHost } from "./bind.js";
export { assertBoundAddress, isLoopbackLiteral } from "./bind.js";
export type { ErrorCode, ErrorSpec, ServerErrorCode } from "./errors.js";
export { ERRORS, SERVER_ERROR_CODES, SwainServerError } from "./errors.js";
export type { ServerLimits } from "./limits.js";
export { DEFAULT_SERVER_LIMITS } from "./limits.js";
export type { Counters, LogEvent, RouteId, SwainServer, SwainServerOptions } from "./server.js";
export { CANONICAL_SCHEMA_VERSION, createSwainServer } from "./server.js";
export type { WebAuthMode } from "./web.js";
export { isAllowedNextPath, issueLoginCode, LOGIN_CODE_TTL_MS } from "./websession.js";
