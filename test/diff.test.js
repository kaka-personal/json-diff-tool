import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../diff.js';

const { parse, diff, format, formatPath, toPatch } = globalThis.JsonDiff;

const run = (a, b, options) => diff(parse(a), parse(b), options).map((d) => `${d.kind} ${formatPath(d.path)}`);

// Minimal RFC 6902 applier for add / remove / replace.
function applyPatch(doc, ops) {
  const root = { v: doc };
  for (const { op, path, value } of ops) {
    const keys = ['v', ...path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))];
    let parent = root;
    for (const k of keys.slice(0, -1)) parent = parent[k];
    const last = keys[keys.length - 1];
    if (Array.isArray(parent)) {
      const i = Number(last);
      if (op === 'remove') parent.splice(i, 1);
      else if (op === 'add') parent.splice(i, 0, value);
      else parent[i] = value;
    } else if (op === 'remove') {
      delete parent[last];
    } else {
      parent[last] = value;
    }
  }
  return root.v;
}

const patched = (a, b) => applyPatch(JSON.parse(a), JSON.parse(toPatch(diff(parse(a), parse(b)), b)));

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

test('numbers compare by exact value, not as doubles', () => {
  assert.deepEqual(run('{"big":12345678901234567890}', '{"big":12345678901234567891}'), ['changed $.big']);
  assert.deepEqual(run('[0.1000000000000000000001]', '[0.1]'), ['changed $[0]']);
  assert.deepEqual(run('[1, 1.0, 1e0, 10E-1, 100, 0.0, -0, -0.50]', '[1.00, 1, 1, 1, 1e2, 0, 0, -5e-1]'), []);
  assert.deepEqual(run('[1, 2]', '[1.0, 20e-1, 3]'), ['added $[2]']);
});

test('ignored key names are skipped at any depth', () => {
  const opts = { ignoreKeys: ['ts'] };
  assert.deepEqual(run('{"ts":1,"a":{"ts":2,"b":1}}', '{"ts":9,"a":{"ts":8,"b":2},"c":{"ts":0}}', opts), [
    'changed $.a.b',
    'added $.c',
  ]);
  assert.deepEqual(run('{"ts":1}', '{}', opts), []);
});

test('ignored paths match exactly, with [*] for array indexes', () => {
  const opts = { ignoreKeys: [' $.items[*].id ', '$["x-y"]', ''] };
  assert.deepEqual(run('{"items":[{"id":1,"n":"a"}],"x-y":1,"id":1}', '{"items":[{"id":2,"n":"a"}],"x-y":2,"id":2}', opts), [
    'changed $.id',
  ]);
});

test('ignored keys do not break array alignment', () => {
  const opts = { ignoreKeys: ['ts'] };
  assert.deepEqual(run('[{"n":1,"ts":1},{"n":2,"ts":1}]', '[{"n":0},{"n":1,"ts":5},{"n":2,"ts":6}]', opts), ['added $[0]']);
});

test('ignoreArrayOrder matches items by value', () => {
  const opts = { ignoreArrayOrder: true };
  assert.deepEqual(run('[1,2,3]', '[3,1,2]', opts), []);
  assert.deepEqual(run('{"a":[[1,2],[3]]}', '{"a":[[3],[2,1]]}', opts), []);
  assert.deepEqual(run('[1,1,2]', '[1,2,2]', opts), ['changed $[2]']);
  assert.deepEqual(run('[{"id":1,"v":"a"},5]', '[5,{"id":1,"v":"b"},7]', opts), ['changed $[1].v', 'added $[2]']);
  assert.deepEqual(run('[1,2,3]', '[2]', opts), ['removed $[0]', 'removed $[2]']);
});

test('toPatch turns the left document into the right one', () => {
  const cases = [
    ['{"a":1,"b":[1,2,3],"c":{"d":true}}', '{"a":2,"b":[0,1,3,4],"c":{},"e":"x"}'],
    ['[1,2,3,4,5]', '[5,4,3,2,1]'],
    ['[{"id":1,"t":[1,2]},{"id":2}]', '[{"id":0},{"id":1,"t":[2,3]},{"id":2,"x":null}]'],
    ['{"a/b":1,"m~n":2}', '{"a/b":3}'],
    ['{"a":1}', '[1]'],
    ['[[1,2],[3,4]]', '[[3,4],[1,2],[]]'],
  ];
  for (const [a, b] of cases) assert.deepEqual(patched(a, b), JSON.parse(b), `${a} -> ${b}`);
});

test('toPatch survives random array edits', () => {
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const randArray = (depth) => Array.from({ length: rand(6) }, () => (depth && rand(3) === 0 ? randArray(depth - 1) : rand(4)));
  for (let i = 0; i < 300; i++) {
    const a = JSON.stringify(randArray(2));
    const b = JSON.stringify(randArray(2));
    assert.deepEqual(patched(a, b), JSON.parse(b), `${a} -> ${b}`);
  }
});

test('toPatch keeps number digits and escapes pointer tokens', () => {
  const b = '{"a/b":12345678901234567890}';
  assert.equal(toPatch(diff(parse('{}'), parse(b)), b), '[{"op":"add","path":"/a~1b","value":12345678901234567890}]');
  assert.equal(toPatch([], ''), '[]');
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
