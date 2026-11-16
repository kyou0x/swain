// as: packages/cli/src/other.ts
process.dlopen(m, "x"); // expect: P-PROCESS
process._linkedBinding("x"); // expect: P-PROCESS
process.binding("x"); // expect: P-PROCESS
process["env"]; // expect: P-PROCESS
process.stdout.write("x"); // expect: P-PROCESS
