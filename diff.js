// JSON parser that keeps source offsets, plus a structural diff between two parsed trees.
// Plain script (no ES module) so the page also works when opened from file://.
(function () {

const STRING_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// Returns null for blank input, otherwise the root node.
// Node: { type, start, end, value?, items?, members? }
// Object members: [{ key, keyStart, node }] (duplicate keys: last one wins, like JSON.parse).
function parse(text) {
  let i = 0;
  const n = text.length;

  function fail(msg) {
    const e = new SyntaxError(msg);
    e.pos = i;
    throw e;
  }

  function ws() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  }

  function readString() {
    STRING_RE.lastIndex = i;
    const m = STRING_RE.exec(text);
    if (!m) fail('Invalid string');
    i += m[0].length;
    return JSON.parse(m[0]);
  }

  function literal(word, type, value) {
    if (text.startsWith(word, i)) {
      const start = i;
      i += word.length;
      return { type, value, start, end: i };
    }
    fail(`Unexpected token '${text[i]}'`);
  }

  function value() {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') {
      const v = readString();
      return { type: 'string', value: v, start, end: i };
    }
    if (c === 't') return literal('true', 'boolean', true);
    if (c === 'f') return literal('false', 'boolean', false);
    if (c === 'n') return literal('null', 'null', null);
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      if (!m) fail('Invalid number');
      i += m[0].length;
      return { type: 'number', value: Number(m[0]), start, end: i };
    }
    fail(c === undefined ? 'Unexpected end of input' : `Unexpected token '${c}'`);
  }

  function object() {
    const start = i++;
    const members = [];
    const index = new Map();
    ws();
    if (text[i] === '}') {
      i++;
      return { type: 'object', members, start, end: i };
    }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('Expected property name');
      const keyStart = i;
      const key = readString();
      ws();
      if (text[i] !== ':') fail("Expected ':'");
      i++;
      const member = { key, keyStart, node: value() };
      if (index.has(key)) members[index.get(key)] = member;
      else {
        index.set(key, members.length);
        members.push(member);
      }
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail("Expected ',' or '}'");
    }
    return { type: 'object', members, start, end: i };
  }

  function array() {
    const start = i++;
    const items = [];
    ws();
    if (text[i] === ']') {
      i++;
      return { type: 'array', items, start, end: i };
    }
    for (;;) {
      items.push(value());
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      fail("Expected ',' or ']'");
    }
    return { type: 'array', items, start, end: i };
  }

  ws();
  if (i === n) return null;
  const root = value();
  ws();
  if (i < n) fail('Unexpected content after JSON');
  return root;
}

// Order-insensitive canonical string of a node, cached on the node.
function canon(node) {
  if (node.canon !== undefined) return node.canon;
  let s;
  if (node.type === 'object') {
    const parts = node.members.map((m) => JSON.stringify(m.key) + ':' + canon(m.node));
    s = '{' + parts.sort().join(',') + '}';
  } else if (node.type === 'array') {
    s = '[' + node.items.map(canon).join(',') + ']';
  } else {
    s = JSON.stringify(node.value);
  }
  node.canon = s;
  return s;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatPath(path) {
  let s = '$';
  for (const p of path) {
    if (typeof p === 'number') s += `[${p}]`;
    else if (IDENT_RE.test(p)) s += '.' + p;
    else s += `[${JSON.stringify(p)}]`;
  }
  return s;
}

// Longest common subsequence over two string arrays; returns matched index pairs.
const LCS_LIMIT = 4e6;
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_LIMIT) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x * w + y] = a[x] === b[y]
        ? dp[(x + 1) * w + y + 1] + 1
        : Math.max(dp[(x + 1) * w + y], dp[x * w + y + 1]);
    }
  }
  const pairs = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { pairs.push([x, y]); x++; y++; }
    else if (dp[(x + 1) * w + y] >= dp[x * w + y + 1]) x++;
    else y++;
  }
  return pairs;
}

// A "slot" is a node plus where its highlight starts (the key for object members).
const slot = (node, from = node.start) => ({ node, from, to: node.end });

// Returns a list of { kind: 'added' | 'removed' | 'changed', path, left, right }.
// left/right are slots; for added/removed the missing side is the containing slot on that side (anchor).
function diff(leftRoot, rightRoot) {
  const out = [];

  function walk(a, b, path) {
    if (canon(a.node) === canon(b.node)) return;
    const ta = a.node.type;
    const tb = b.node.type;
    if (ta === 'object' && tb === 'object') {
      const bMap = new Map(b.node.members.map((m) => [m.key, m]));
      const aKeys = new Set();
      for (const m of a.node.members) {
        aKeys.add(m.key);
        const mb = bMap.get(m.key);
        const sa = slot(m.node, m.keyStart);
        if (mb) walk(sa, slot(mb.node, mb.keyStart), [...path, m.key]);
        else out.push({ kind: 'removed', path: [...path, m.key], left: sa, right: b, anchor: 'right' });
      }
      for (const m of b.node.members) {
        if (!aKeys.has(m.key)) {
          out.push({ kind: 'added', path: [...path, m.key], left: a, right: slot(m.node, m.keyStart), anchor: 'left' });
        }
      }
      return;
    }
    if (ta === 'array' && tb === 'array') {
      const ai = a.node.items;
      const bi = b.node.items;
      const pairs = lcsPairs(ai.map(canon), bi.map(canon)) || [];
      pairs.push([ai.length, bi.length]);
      let x = 0;
      let y = 0;
      for (const [px, py] of pairs) {
        // Pair up unmatched items inside the gap so nested changes stay granular.
        while (x < px && y < py) {
          walk(slot(ai[x]), slot(bi[y]), [...path, y]);
          x++; y++;
        }
        for (; x < px; x++) out.push({ kind: 'removed', path: [...path, x], left: slot(ai[x]), right: b, anchor: 'right' });
        for (; y < py; y++) out.push({ kind: 'added', path: [...path, y], left: a, right: slot(bi[y]), anchor: 'left' });
        x = px + 1;
        y = py + 1;
      }
      return;
    }
    out.push({ kind: 'changed', path, left: a, right: b, anchor: null });
  }

  if (leftRoot && rightRoot) walk(slot(leftRoot), slot(rightRoot), []);
  return out;
}

globalThis.JsonDiff = { parse, diff, formatPath };
})();
