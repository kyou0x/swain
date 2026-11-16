// as: packages/core/src/x.ts
Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), "constructor").value; // expect: P-CTOR
x[`__proto__`]; // expect: P-CTOR
new WeakRef(o); // expect: P-IDENT
new FinalizationRegistry(f); // expect: P-IDENT
navigator.userAgent; // expect: P-IDENT
localStorage; // expect: P-IDENT
sessionStorage; // expect: P-IDENT
x.__lookupGetter__("y"); // expect: P-CTOR
class K extends Function {} // expect: P-IDENT
