/**
 * Best-effort masking of secrets in retained inline content (SPEC-002 section 3.4 step 9, PA-3).
 * Pure. Masking is NOT a guarantee: every output that carries inline content says so.
 * Patterns avoid nested unbounded quantifiers; assignment keys are anchored at a word start so
 * matching stays linear on hostile input.
 */

export const REDACTION_MARK = "[REDACTED]";

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

interface Rule {
  readonly re: RegExp;
  /** Replacement built from the match; the callback keeps non-secret context. */
  readonly replace: (...groups: string[]) => string;
}

const KEY_WORD = "(?:password|passwd|secret|token|api[_-]?key)";

const RULES: readonly Rule[] = [
  // PEM private key blocks; an unterminated block is masked to the end of the text.
  {
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
    replace: () => REDACTION_MARK,
  },
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replace: () => REDACTION_MARK },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: () => REDACTION_MARK },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTION_MARK },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTION_MARK },
  { re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, replace: () => REDACTION_MARK },
  {
    re: /(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, head = "") => `${head}${REDACTION_MARK}`,
  },
  {
    re: new RegExp(
      `((?<![\\w.-])[\\w.-]{0,64}${KEY_WORD}[\\w-]{0,32}["']?[ \\t]*[=:][ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`,
      "gi",
    ),
    replace: (_m, head = "", value = "") => {
      const bare = value.replace(/^["']|["']$/g, "");
      if (bare === "" || bare === REDACTION_MARK) return `${head}${value}`;
      return `${head}${REDACTION_MARK}`;
    },
  },
];

function applyRules(rules: readonly Rule[], s: string): RedactionResult {
  let text = s;
  let count = 0;
  for (const rule of rules) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const groups = args.filter((a): a is string => typeof a === "string");
      const whole = groups[0] ?? "";
      const out = rule.replace(...groups);
      if (out !== whole) count++;
      return out;
    });
  }
  return { text, count };
}

/** Mask secrets in `s`. `count` is the number of masked spans. Unchanged by the Swain extensions. */
export function redactText(s: string): RedactionResult {
  return applyRules(RULES, s);
}

// ---- Swain extensions (ADR-0005 section 6.4, SPEC-003 N1.4) ---------------------------------
// Kept out of `redactText` so every `atm` golden stays byte-identical; the receiver-side content
// policy (`@swain/model`) uses `redactTextExtended`. Every pattern is linear: single character
// classes with a bounded or unbounded quantifier, no nested quantifiers, no alternation of
// overlapping repeats.

const NOT_ID = "(?<![A-Za-z0-9_])";
const mark = (): string => REDACTION_MARK;
const keepHead = (_m: string, head = "", value = ""): string =>
  value === REDACTION_MARK ? `${head}${value}` : `${head}${REDACTION_MARK}`;

const EXTENDED_RULES: readonly Rule[] = [
  // JWT-like: three base64url segments, the first starting with the encoded `{"`.
  {
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: mark,
  },
  // HTTP Basic credentials.
  {
    re: /(\bBasic[ \t]+)[A-Za-z0-9+/]{12,}={0,2}/g,
    replace: (_m, head = "") => `${head}${REDACTION_MARK}`,
  },
  // A Swain ingest key `swn_<16 hex>_<64 hex>`, also when it is only a prefix of a longer run and
  // when glued to other text (`Bearer%20swn_...`): no left boundary on purpose.
  { re: /swn_[0-9a-fA-F]{16}_[0-9a-fA-F]{8,}/g, replace: mark },
  // Vendor token prefixes.
  { re: new RegExp(`${NOT_ID}AIza[0-9A-Za-z_-]{35}`, "g"), replace: mark },
  { re: new RegExp(`${NOT_ID}[sr]k_live_[A-Za-z0-9]{10,}`, "g"), replace: mark },
  { re: new RegExp(`${NOT_ID}glpat-[A-Za-z0-9_-]{20,}`, "g"), replace: mark },
  { re: new RegExp(`${NOT_ID}npm_[A-Za-z0-9]{20,}`, "g"), replace: mark },
  { re: new RegExp(`${NOT_ID}hf_[A-Za-z0-9]{20,}`, "g"), replace: mark },
  { re: new RegExp(`${NOT_ID}ya29\\.[A-Za-z0-9_-]{20,}`, "g"), replace: mark },
  {
    re: new RegExp(`${NOT_ID}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, "g"),
    replace: mark,
  },
  // Slack and Discord webhook URLs.
  {
    re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
    replace: mark,
  },
  {
    re: /https:\/\/(?:discord|discordapp)\.com\/api\/(?:v[0-9]{1,2}\/)?webhooks\/[0-9]{1,24}\/[A-Za-z0-9_-]+/g,
    replace: mark,
  },
  // URL userinfo `scheme://user:pass@` (covers postgres, mysql, mongodb(+srv), redis, amqp, https).
  {
    re: /\b([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s/?#@]+@/g,
    replace: (_m, head = "") => `${head}${REDACTION_MARK}@`,
  },
  // ADO-style `Pwd=...` (`Password=` is covered by the base rules).
  {
    re: /((?<![\w.-])Pwd[ \t]*=[ \t]*)("[^"\n]*"|'[^'\n]*'|[^;\s"']+)/gi,
    replace: keepHead,
  },
  // Signature-like query parameters.
  {
    re: /([?&;](?:sig|signature|x-amz-signature|x-goog-signature|token|access_token)=)[^&\s#"';]+/gi,
    replace: keepHead,
  },
  // CLI flag forms: `--password x`, `--token x`, ... (`--password=x` is covered by the base rules).
  {
    re: /(--(?:password|passwd|pass|token|secret|api[_-]?key|access[_-]?token)[ \t]+)(?!-)[^\s]+/gi,
    replace: keepHead,
  },
  // curl-style `-u user:pass`.
  {
    re: /((?:^|\s)-u[ \t]+)[^\s:]+:[^\s]+/g,
    replace: (_m, head = "") => `${head}${REDACTION_MARK}`,
  },
  // `-p secret` / `-psecret` after mysql, mysqldump, mariadb or psql. A purely numeric value after
  // a space is a port or a database name and is kept.
  {
    re: /(\b(?:mysql|mysqldump|mariadb|psql)\b[^\n|;&]{0,200}?[ \t]-p)([ \t]*)(?![-\s])(\S+)/g,
    replace: (_m, head = "", gap = "", value = "") =>
      gap !== "" && /^[0-9]+$/.test(value)
        ? `${head}${gap}${value}`
        : `${head}${gap}${REDACTION_MARK}`,
  },
];

const ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;
const MIN_ENTROPY_BITS = 4.0;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const EXEMPT_HEX_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{32}|[0-9a-f]{64})$/;

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropySecret(token: string): boolean {
  if (UUID_RE.test(token) || EXEMPT_HEX_RE.test(token)) return false;
  let classes = 0;
  if (/[a-z]/.test(token)) classes++;
  if (/[A-Z]/.test(token)) classes++;
  if (/[0-9]/.test(token)) classes++;
  if (/[+/_=-]/.test(token)) classes++;
  if (classes < 3) return false;
  return shannonBitsPerChar(token) >= MIN_ENTROPY_BITS;
}

/**
 * `redactText` plus the ADR-0005 section 6.4 additions: JWT, Basic, vendor token prefixes,
 * webhook URLs, URL userinfo and connection strings, `Pwd=`, signature query parameters, CLI
 * flag forms, and a high-entropy heuristic (>= 24 characters, >= 3 character classes, >= 4.0
 * bits per character; canonical UUIDs and 16/32/64-character lowercase hex are exempt).
 * Best-effort, like `redactText`.
 */
export function redactTextExtended(s: string): RedactionResult {
  const base = applyRules([...RULES, ...EXTENDED_RULES], s);
  let count = base.count;
  const text = base.text.replace(ENTROPY_TOKEN, (token) => {
    if (!isHighEntropySecret(token)) return token;
    count++;
    return REDACTION_MARK;
  });
  return { text, count };
}
