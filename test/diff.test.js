import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../diff.js';

const { parse, diff, formatPath } = globalThis.JsonDiff;

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
