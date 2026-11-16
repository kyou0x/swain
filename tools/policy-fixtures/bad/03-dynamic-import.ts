// as: packages/core/src/x.ts
declare const v: string;
import("node:child" + "_process"); // expect: P-DYNIMPORT
import(v); // expect: P-DYNIMPORT
import(`node:fs`); // expect: P-DYNIMPORT
