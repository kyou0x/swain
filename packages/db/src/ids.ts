/**
 * Tenant and entity identifiers (ADR-0005 section 2). `org`, `wsp`, `prj` are random (the caller
 * injects the entropy), `agt` and `run` are derived by `@swain/model`.
 */
export type OrgId = `org_${string}`;
export type WspId = `wsp_${string}`;
export type PrjId = `prj_${string}`;
export type AgtId = `agt_${string}`;
export type RunId = `run_${string}`;
export type KeyId = `key_${string}`;
/** 1 to 128 printable ASCII characters. */
export type BatchId = string;

const HEX32 = /^[0-9a-f]{32}$/;

function prefixed(prefix: string, v: unknown): v is string {
  return typeof v === "string" && v.startsWith(prefix) && HEX32.test(v.slice(prefix.length));
}

export const isOrgId = (v: unknown): v is OrgId => prefixed("org_", v);
export const isWspId = (v: unknown): v is WspId => prefixed("wsp_", v);
export const isPrjId = (v: unknown): v is PrjId => prefixed("prj_", v);
export const isAgtId = (v: unknown): v is AgtId => prefixed("agt_", v);
export const isRunId = (v: unknown): v is RunId => prefixed("run_", v);
export const isKeyId = (v: unknown): v is KeyId =>
  typeof v === "string" && /^key_[0-9a-f]{16}$/.test(v);

export function isBatchId(v: unknown): v is BatchId {
  return typeof v === "string" && /^[\x21-\x7e]{1,128}$/.test(v);
}

export const isHex64 = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const isTraceId = (v: unknown): v is string => typeof v === "string" && HEX32.test(v);
export const isSpanId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
