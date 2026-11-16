// Declares the only environment variables the two bins may read. The repo compiles with
// `noPropertyAccessFromIndexSignature`, and policy-check allows only dotted access
// (`process.env.HOME`), so the names must exist as declared properties. `src/bin.ts` (atm) reads
// HOME and XDG_DATA_HOME; `src/swain-bin.ts` reads the rest (tools/policy-check.mjs SWAIN_ENV_KEYS).
declare namespace NodeJS {
  interface ProcessEnv {
    HOME?: string;
    XDG_DATA_HOME?: string;
    XDG_CONFIG_HOME?: string;
    XDG_STATE_HOME?: string;
    SWAIN_SERVER_URL?: string;
    SWAIN_DB?: string;
  }
}
