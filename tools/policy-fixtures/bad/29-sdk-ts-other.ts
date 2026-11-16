// as: packages/sdk-ts/src/other.ts
setTimeout(() => 1, 5); // expect: P-IDENT
const t = setTimeout; // expect: P-IDENT
setInterval(() => 1, 5); // expect: P-IDENT
setImmediate(() => 1); // expect: P-IDENT
