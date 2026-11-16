// as: packages/cli/src/main.ts
const h = process.env.HOME; // expect: P-PROCESS
const f = Date.now; // expect: P-DATE
const g = process.stdout; // expect: P-PROCESS
