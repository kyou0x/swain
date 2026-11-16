// as: packages/core/src/x.ts
(() => {}).constructor("return 1"); // expect: P-CTOR
const { constructor: C } = () => {}; // expect: P-CTOR
Reflect.construct(Function, []); // expect: P-IDENT
const o = { __proto__: null }; // expect: P-CTOR
