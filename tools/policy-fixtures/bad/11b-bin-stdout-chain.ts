// as: packages/cli/src/bin.ts
process.stdout._handle; // expect: P-PROCESS
process.stdout.constructor; // expect: P-PROCESS P-CTOR
process.env; // expect: P-PROCESS
const s = process.stdout; // expect: P-PROCESS
process["argv"]; // expect: P-PROCESS
