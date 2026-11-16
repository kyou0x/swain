/** Fixed adapter order (SPEC-002 section 8): claude-code, codex-cli, gemini-cli, opencode. */
import { registrations as claudeCode } from "@swain/adapter-claude-code";
import { registrations as codexCli } from "@swain/adapter-codex-cli";
import { registrations as geminiCli } from "@swain/adapter-gemini-cli";
import { registrations as opencode } from "@swain/adapter-opencode";
import type { AdapterRegistration } from "@swain/core";

export const REGISTRATIONS: readonly AdapterRegistration[] = Object.freeze([
  ...claudeCode,
  ...codexCli,
  ...geminiCli,
  ...opencode,
]);
