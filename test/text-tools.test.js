import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../text-tools.js';

const { tokenize, repair } = globalThis.JsonText;

const fixed = (text) => {
  const r = repair(text);
  assert.ok(r.ok, `repair failed for ${text}: ${r.error}`);
  return JSON.parse(r.text);
};

test('tokenize classifies keys, values and punctuation', () => {
  const text = '{"a": [1, "x", true, null]}';
  const types = tokenize(text).map((t) => `${t.type}:${text.slice(t.start, t.end)}`);
  assert.deepEqual(types, [
    'punc:{', 'key:"a"', 'punc::', 'punc:[', 'num:1', 'punc:,', 'str:"x"', 'punc:,',
    'lit:true', 'punc:,', 'lit:null', 'punc:]', 'punc:}',
  ]);
});

test('tokenize tolerates invalid input', () => {
  const tokens = tokenize('{"a": oops, "b');
  assert.equal(tokens.at(-1).type, 'str');
});

test('repair leaves valid JSON unchanged apart from formatting', () => {
  assert.equal(repair('{"a":[1,2]}').text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
});

test('repair handles JavaScript-style objects', () => {
  assert.deepEqual(fixed("{a: 'x', b: [1, 2,], // note\n /* c */ c: \"it's\",}"), { a: 'x', b: [1, 2], c: "it's" });
});

test('repair handles Python and JS literals', () => {
  assert.deepEqual(fixed('{"a": True, "b": None, "c": undefined, "d": NaN}'), { a: true, b: null, c: null, d: null });
});

test('repair inserts missing commas and colons', () => {
  assert.deepEqual(fixed('{"a" 1 "b": 2\n"c": [1 2 3]}'), { a: 1, b: 2, c: [1, 2, 3] });
});

test('repair closes truncated documents', () => {
  assert.deepEqual(fixed('{"a": [1, 2, {"b": "tex'), { a: [1, 2, { b: 'tex' }] });
  assert.deepEqual(fixed('{"a": '), { a: null });
});

test('repair drops stray closers and duplicate commas', () => {
  assert.deepEqual(fixed('[1,, 2]]'), [1, 2]);
});

test('repair unwraps JSONP and function wrappers', () => {
  assert.deepEqual(fixed('callback({"id": ObjectId("abc"), "n": 1});'), { id: 'abc', n: 1 });
});

test('repair escapes raw control characters inside strings', () => {
  assert.deepEqual(fixed('{"a": "line1\nline2\ttab"}'), { a: 'line1\nline2\ttab' });
});

test('repair parses escaped JSON strings', () => {
  assert.deepEqual(fixed('"{\\"a\\":1}"'), { a: 1 });
});

test('repair turns NDJSON into an array', () => {
  assert.deepEqual(fixed('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
});

test('repair reports failure when nothing is recoverable', () => {
  assert.equal(repair('').ok, false);
});
