// as: packages/cli/src/bin.ts
other({ stdout: process.stdout, nowMs: Date.now, h: process.env.HOME }); // expect: P-PROCESS P-DATE
obj.runMain({ stdout: process.stdout }); // expect: P-PROCESS
runMain(() => {}, other({ stdout: process.stdout })); // expect: P-PROCESS
