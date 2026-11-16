// as: packages/core/src/x.ts
(0, eval)("1"); // expect: P-IDENT
globalThis["ev" + "al"]("1"); // expect: P-IDENT
eval("1"); // expect: P-IDENT
Function("return 1")(); // expect: P-IDENT
