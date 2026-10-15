import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../diff.js';

const { parse, diff, format, formatPath } = globalThis.JsonDiff;

const run = (a, b) => diff(parse(a), parse(b)).map((d) => `${d.kind} ${formatPath(d.path)}`);

test('parse matches JSON.parse and records offsets', () => {
  const text = '{ "a": [1, true, null], "b": { "c": "x" } }';
  const root = parse(text);
  assert.equal(root.type, 'object');
  assert.equal(root.start, 0);
  assert.equal(root.end, text.length);
  const b = root.members[1];
  assert.equal(text.slice(b.keyStart, b.node.end), '"b": { "c": "x" }');
  assert.equal(root.members[0].node.items[1].value, true);
});

test('parse returns null for blank input', () => {
  assert.equal(parse('  \n '), null);
});

test('parse errors carry a position', () => {
  const text = '{"a": 1,}';
  assert.throws(() => parse(text), (e) => e instanceof SyntaxError && e.pos === 8);
  assert.throws(() => parse('[1] x'), /Unexpected content/);
  assert.throws(() => parse('{"a" 1}'), /Expected ':'/);
});

test('identical documents and key order do not produce diffs', () => {
  assert.deepEqual(run('{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }'), []);
});

test('detects added, removed and changed members', () => {
  assert.deepEqual(run('{"a":1,"b":2,"c":{"d":true}}', '{"a":1,"c":{"d":false},"e":null}'), [
    'removed $.b',
    'changed $.c.d',
    'added $.e',
  ]);
});

test('type change is reported as a single change', () => {
  assert.deepEqual(run('{"a":{"x":1}}', '{"a":[1]}'), ['changed $.a']);
});

test('array insertion is aligned instead of shifting every item', () => {
  assert.deepEqual(run('[1,2,3]', '[0,1,2,3]'), ['added $[0]']);
  assert.deepEqual(run('[1,2,3]', '[1,3]'), ['removed $[1]']);
});

test('modified array items are diffed recursively', () => {
  assert.deepEqual(run('[{"id":1,"n":"a"},{"id":2}]', '[{"id":1,"n":"b"},{"id":2}]'), ['changed $[0].n']);
});

test('diff slots point at source ranges', () => {
  const left = '{"a": 1, "b": "old"}';
  const right = '{"a": 1, "b": "new", "c": 3}';
  const [changed, added] = diff(parse(left), parse(right));
  assert.equal(left.slice(changed.left.from, changed.left.to), '"b": "old"');
  assert.equal(right.slice(added.right.from, added.right.to), '"c": 3');
});

test('formatPath quotes non-identifier keys', () => {
  assert.equal(formatPath(['a', 0, 'b-c']), '$.a[0]["b-c"]');
});

test('format indents nested values and keeps empty containers inline', () => {
  assert.equal(format('{"a":[1,{"b":null}],"c":{},"d":[ ]}', '  '),
    '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}');
  assert.equal(format('[1,2]', '\t'), '[\n\t1,\n\t2\n]');
});

test('format with an empty indent minifies', () => {
  assert.equal(format('{\n  "a" : [ 1 , 2 ],\n  "b": { }\n}', ''), '{"a":[1,2],"b":{}}');
});

test('format leaves strings, numbers and duplicate keys untouched', () => {
  const text = '{"s":"a, b: {c} [d] \\" \\u00e9","n":12345678901234567890,"n":1.50e+3}';
  assert.equal(format(text, ''), text);
  assert.equal(format(format(text, '    '), ''), text);
});

test('formatted output parses to the same value', () => {
  const text = '{"a":[true,false,null,-0.5,"x\\ny"],"b":{"c":[[],[{}]]}}';
  assert.deepEqual(JSON.parse(format(text, '  ')), JSON.parse(text));
  assert.equal(format(text, ''), text);
});
