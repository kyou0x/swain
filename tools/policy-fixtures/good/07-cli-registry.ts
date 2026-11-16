// as: packages/cli/src/registry.ts
import { registrations as claude } from "@swain/adapter-claude-code";
import { registrations as codex } from "@swain/adapter-codex-cli";
import { registrations as gemini } from "@swain/adapter-gemini-cli";
import { registrations as opencode } from "@swain/adapter-opencode";
import { type AdapterRegistration, escapeControlChars } from "@swain/core";
import { renderMarkdown } from "@swain/report";
import { openStore } from "@swain/store";

export const all: readonly AdapterRegistration[] = [...claude, ...codex, ...gemini, ...opencode];
export const used = [escapeControlChars, renderMarkdown, openStore];
