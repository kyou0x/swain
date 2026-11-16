// as: packages/core/src/x.ts
d.getFullYear(); // expect: P-DATELOCAL
d.getYear(); // expect: P-DATELOCAL
d.getMonth(); // expect: P-DATELOCAL
d.getDate(); // expect: P-DATELOCAL
d.getDay(); // expect: P-DATELOCAL
d.getHours(); // expect: P-DATELOCAL
d.getMinutes(); // expect: P-DATELOCAL
d.getSeconds(); // expect: P-DATELOCAL
d.getMilliseconds(); // expect: P-DATELOCAL
d.getTimezoneOffset(); // expect: P-DATELOCAL
d.setFullYear(); // expect: P-DATELOCAL
d.setMonth(); // expect: P-DATELOCAL
d.setDate(); // expect: P-DATELOCAL
d.setHours(); // expect: P-DATELOCAL
d.setMinutes(); // expect: P-DATELOCAL
d.setSeconds(); // expect: P-DATELOCAL
d.setMilliseconds(); // expect: P-DATELOCAL
d.toDateString(); // expect: P-DATELOCAL
d.toTimeString(); // expect: P-DATELOCAL
d["getHours"](); // expect: P-DATELOCAL
d[("setDate")](1); // expect: P-DATELOCAL
d[`toDateString`](); // expect: P-DATELOCAL
const f = d.getFullYear; // expect: P-DATELOCAL
new Date(0).getMonth(); // expect: P-DATELOCAL
(x as Date).getTimezoneOffset(); // expect: P-DATELOCAL
const { getDay } = d; // expect: P-DATELOCAL
const { getDate: gd } = d; // expect: P-DATELOCAL
const { ["getHours"]: gh } = d; // expect: P-DATELOCAL
({ getSeconds: s1 } = d); // expect: P-DATELOCAL
Date.prototype.getFullYear.call(d); // expect: P-DATELOCAL
d.getUTCFullYear();
d.getUTCMonth();
d.getUTCDate();
d.getUTCDay();
d.getUTCHours();
d.getTime();
d.toISOString();
d.toUTCString();
