// as: packages/core/src/x.ts
import "node:wasi"; // expect: P-IMPORT
WebAssembly.instantiate(x); // expect: P-IDENT
globalThis["fetch"]; // expect: P-IDENT
new EventSource(u); // expect: P-IDENT
