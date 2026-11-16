// as: packages/report/src/x.ts
declare const o: { loadExtension(p: string): void; enableLoadExtension(b: boolean): void };
o.loadExtension("x"); // expect: P-SQL
o.enableLoadExtension(true); // expect: P-SQL
o["loadExtension"]("x"); // expect: P-SQL
const { loadExtension } = o; // expect: P-SQL
export { loadExtension };
