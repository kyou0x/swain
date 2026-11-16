import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { frameSource } from "../../src/ingest/frame/index.js";

const enc = new TextEncoder();
const first = (text: string) =>
  frameSource(enc.encode(text), { kind: "jsonl" }, DEFAULT_BOUNDS).records[0];

test("differential: the scanner accepts exactly what JSON.parse accepts (seeded mutations)", () => {
  let seed = 0x2545f491;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const corpus = [
    '{"a":[1,2.5e3,-0,{"b":null}],"c":"x\\u00e9\\n","d":true,"e":{}}',
    '[[],[[]],{"k":[{"k":[]}]},"s",0,-1.25E-2]',
    '"just a string"',
    '{"nested":{"deeper":{"deepest":[1,[2,[3]]]}}}',
  ];
  const alphabet = '{}[]",:\\ 0123456789.eE+-tfnul\n\tabxyz';
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 4000; i++) {
    const chars = [...(corpus[rnd(corpus.length)] ?? "")];
    const edits = 1 + rnd(3);
    for (let k = 0; k < edits; k++) {
      const at = rnd(chars.length + 1);
      const op = rnd(3);
      if (op === 0) chars.splice(at, 1);
      else if (op === 1) chars.splice(at, 0, alphabet[rnd(alphabet.length)] ?? "x");
      else chars[at] = alphabet[rnd(alphabet.length)] ?? "x";
    }
    // A raw newline would split the line; the scanner is exercised per line.
    const text = chars.join("").replace(/\n/g, " ");
    if (text.trim() === "") continue;
    let expected = true;
    try {
      JSON.parse(text);
    } catch {
      expected = false;
    }
    assert.equal(first(text)?.parse.ok === true, expected, JSON.stringify(text));
    if (expected) accepted++;
    else rejected++;
  }
  assert.ok(accepted > 100 && rejected > 100, `${accepted}/${rejected}`);
});

test("differential: a document wrapper agrees with JSON.parse on element validity", () => {
  const elements = ['{"a":1}', "[1,2]", '"s"', "7", "null", '{"a":', "[1,", '{"a":1,}', "tru"];
  for (const el of elements) {
    const text = `{"m":[${el}]}`;
    let expected = true;
    try {
      JSON.parse(text);
    } catch {
      expected = false;
    }
    const r = frameSource(
      enc.encode(text),
      { kind: "json-document", recordArrays: ["/m"] },
      DEFAULT_BOUNDS,
    );
    const ok = r.records[0]?.parse.ok === true;
    assert.equal(ok, expected, text);
    assert.equal(r.records.length, expected ? 2 : 1, text);
  }
});
