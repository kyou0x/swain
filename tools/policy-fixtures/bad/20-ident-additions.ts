// as: packages/core/src/x.ts
Buffer.from("a"); // expect: P-IDENT
new Event("x"); // expect: P-IDENT
new EventTarget(); // expect: P-IDENT
new PerformanceMark("m"); // expect: P-IDENT
new PerformanceMeasure(); // expect: P-IDENT
new PerformanceObserver(() => {}); // expect: P-IDENT
const pe = PerformanceEntry; // expect: P-IDENT
new BroadcastChannel("c"); // expect: P-IDENT
new MessageChannel(); // expect: P-IDENT
const typeOnly: Buffer | Event | EventTarget | MessageChannel | BroadcastChannel = null as never;
