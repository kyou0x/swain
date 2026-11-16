// as: packages/core/src/x.ts
const { ["localeCompare"]: a } = "x"; // expect: P-LOCALE
const { [("localeCompare")]: b } = "x"; // expect: P-LOCALE
const { [`toLocaleString`]: c } = 1; // expect: P-LOCALE
const { ["localeCompare" as string]: d } = "x"; // expect: P-LOCALE
x[("localeCompare")]("a"); // expect: P-LOCALE
x[("localeCompare" as string)]("a"); // expect: P-LOCALE
x[(("toLocaleUpperCase"))](); // expect: P-LOCALE
x[<string>"toLocaleLowerCase"](); // expect: P-LOCALE
x[("toLocaleDateString")!](); // expect: P-LOCALE
({ localeCompare: e } = "x"); // expect: P-LOCALE
({ ["toLocaleTimeString"]: f } = "x"); // expect: P-LOCALE
[{ toLocaleString: g }] = [1]; // expect: P-LOCALE
({ a: { localeCompare: h } } = y); // expect: P-LOCALE
for ({ localeCompare: i } of z) {} // expect: P-LOCALE
const ok = { localeCompareX: 1, ["other"]: 2 };
const { ["other"]: fine } = ok;
