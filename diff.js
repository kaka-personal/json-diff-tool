// JSON parser that keeps source offsets, a whitespace-only formatter, a structural diff between two parsed trees and JSON Patch export.
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

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const keySegment = (key) => (IDENT_RE.test(key) ? '.' + key : `[${JSON.stringify(key)}]`);

function formatPath(path) {
  let s = '$';
  for (const p of path) s += typeof p === 'number' ? `[${p}]` : keySegment(p);
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

// Ignore rules: a bare key name matches that key at any depth; a rule starting with "$" matches one path,
// written like formatPath output with [*] for any array index (e.g. $.items[*].id).
function ignoreMatcher(rules = []) {
  const names = new Set();
  const paths = new Set();
  for (const r of rules) {
    const rule = r.trim();
    if (rule) (rule[0] === '$' ? paths : names).add(rule);
  }
  if (!names.size && !paths.size) return null;
  return (key, keyPath) => names.has(key) || paths.has(keyPath);
}

// Returns a list of { kind: 'added' | 'removed' | 'changed', path, left, right }.
// left/right are slots; for added/removed the missing side is the containing slot on that side (anchor).
// options.ignoreKeys: ignore rules (see ignoreMatcher); options.ignoreArrayOrder: compare arrays as multisets.
function diff(leftRoot, rightRoot, options = {}) {
  const out = [];
  const ignored = ignoreMatcher(options.ignoreKeys);
  const unordered = !!options.ignoreArrayOrder;
  const memo = new Map();

  // Members that take part in the comparison, each with its pattern path (array indexes as [*]).
  const membersOf = (node, pp) => {
    const list = node.members.map((m) => ({ m, pp: pp + keySegment(m.key) }));
    return ignored ? list.filter((e) => !ignored(e.m.key, e.pp)) : list;
  };

  // Canonical string of a node: key order never matters, item order only when arrays are ordered.
  function canon(node, pp) {
    let s = memo.get(node);
    if (s !== undefined) return s;
    if (node.type === 'object') {
      const parts = membersOf(node, pp).map((e) => JSON.stringify(e.m.key) + ':' + canon(e.m.node, e.pp));
      s = '{' + parts.sort().join(',') + '}';
    } else if (node.type === 'array') {
      const parts = node.items.map((item) => canon(item, pp + '[*]'));
      s = '[' + (unordered ? parts.sort() : parts).join(',') + ']';
    } else {
      s = JSON.stringify(node.value);
    }
    memo.set(node, s);
    return s;
  }

  // Equal items matched by value regardless of position; the leftovers are paired in order.
  function unorderedWalk(a, b, ac, bc, path, pp) {
    const ai = a.node.items;
    const bi = b.node.items;
    const free = new Map();
    bc.forEach((c, y) => {
      if (!free.has(c)) free.set(c, []);
      free.get(c).push(y);
    });
    const restA = [];
    ai.forEach((_, x) => {
      const q = free.get(ac[x]);
      if (q && q.length) q.shift();
      else restA.push(x);
    });
    const restB = [];
    for (const q of free.values()) restB.push(...q);
    restB.sort((p, q) => p - q);
    const n = Math.min(restA.length, restB.length);
    for (let k = 0; k < n; k++) walk(slot(ai[restA[k]]), slot(bi[restB[k]]), [...path, restB[k]], pp);
    for (const x of restA.slice(n)) out.push({ kind: 'removed', path: [...path, x], left: slot(ai[x]), right: b, anchor: 'right' });
    for (const y of restB.slice(n)) out.push({ kind: 'added', path: [...path, y], left: a, right: slot(bi[y]), anchor: 'left' });
  }

  function walk(a, b, path, pp) {
    if (canon(a.node, pp) === canon(b.node, pp)) return;
    const ta = a.node.type;
    const tb = b.node.type;
    if (ta === 'object' && tb === 'object') {
      const bMap = new Map(membersOf(b.node, pp).map((e) => [e.m.key, e.m]));
      const aKeys = new Set();
      for (const { m, pp: kp } of membersOf(a.node, pp)) {
        aKeys.add(m.key);
        const mb = bMap.get(m.key);
        const sa = slot(m.node, m.keyStart);
        if (mb) walk(sa, slot(mb.node, mb.keyStart), [...path, m.key], kp);
        else out.push({ kind: 'removed', path: [...path, m.key], left: sa, right: b, anchor: 'right' });
      }
      for (const m of bMap.values()) {
        if (!aKeys.has(m.key)) {
          out.push({ kind: 'added', path: [...path, m.key], left: a, right: slot(m.node, m.keyStart), anchor: 'left' });
        }
      }
      return;
    }
    if (ta === 'array' && tb === 'array') {
      const ai = a.node.items;
      const bi = b.node.items;
      const ip = pp + '[*]';
      const ac = ai.map((item) => canon(item, ip));
      const bc = bi.map((item) => canon(item, ip));
      if (unordered) {
        unorderedWalk(a, b, ac, bc, path, ip);
        return;
      }
      const pairs = lcsPairs(ac, bc) || [];
      pairs.push([ai.length, bi.length]);
      let x = 0;
      let y = 0;
      for (const [px, py] of pairs) {
        // Pair up unmatched items inside the gap so nested changes stay granular.
        while (x < px && y < py) {
          walk(slot(ai[x]), slot(bi[y]), [...path, y], ip);
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

  if (leftRoot && rightRoot) walk(slot(leftRoot), slot(rightRoot), [], '$');
  return out;
}

const pointer = (path) => path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
const OP_RANK = { removed: 0, added: 1, changed: 2 };

// RFC 6902 JSON Patch text that turns the left document into the right one, for diffs of ordered arrays.
// Values are copied from the right source text, so numbers keep their exact digits.
// Ops run shallow paths first; within an array removals go from the end, then insertions from the start,
// so every index is valid when its op is applied.
function toPatch(diffs, rightText) {
  const ops = diffs.map((d) => ({ d, parent: pointer(d.path.slice(0, -1)), idx: d.path[d.path.length - 1] }));
  const byIndex = (p, q) => {
    if (typeof p.idx !== 'number') return 0;
    return p.d.kind === 'removed' ? q.idx - p.idx : p.idx - q.idx;
  };
  ops.sort((p, q) => p.d.path.length - q.d.path.length
    || (p.parent < q.parent ? -1 : p.parent > q.parent ? 1 : 0)
    || OP_RANK[p.d.kind] - OP_RANK[q.d.kind]
    || byIndex(p, q));
  const parts = ops.map(({ d }) => {
    const path = JSON.stringify(pointer(d.path));
    if (d.kind === 'removed') return `{"op":"remove","path":${path}}`;
    const node = d.right.node;
    const value = format(rightText.slice(node.start, node.end), '');
    return `{"op":"${d.kind === 'added' ? 'add' : 'replace'}","path":${path},"value":${value}}`;
  });
  return '[' + parts.join(',') + ']';
}

// Re-indents valid JSON by rewriting whitespace only, so numbers, escapes and duplicate keys stay exactly as written.
// An empty indent produces minified output.
function format(text, indent) {
  const nl = (depth) => (indent ? '\n' + indent.repeat(depth) : '');
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      STRING_RE.lastIndex = i;
      const s = STRING_RE.exec(text)[0];
      out += s;
      i += s.length - 1;
    } else if (c === '{' || c === '[') {
      let j = i + 1;
      while (isWs(text[j])) j++;
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j];
        i = j;
      } else {
        out += c + nl(++depth);
      }
    } else if (c === '}' || c === ']') {
      out += nl(--depth) + c;
    } else if (c === ',') {
      out += ',' + nl(depth);
    } else if (c === ':') {
      out += indent ? ': ' : ':';
    } else if (!isWs(c)) {
      out += c;
    }
  }
  return out;
}

globalThis.JsonDiff = { parse, diff, format, formatPath, toPatch };
})();
