// Lenient tokenizer for syntax highlighting, and a best-effort JSON repair.
// Plain script (no ES module) so the page also works when opened from file://.
(function () {

// Tokens: { type: 'key' | 'str' | 'num' | 'lit' | 'punc', start, end }. Unknown characters are skipped.
const TOKEN_RE = /("(?:[^"\\\n]|\\.)*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\]:,])/g;
const COLON_RE = /\s*:/y;

function tokenize(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    let type;
    if (m[1] !== undefined) {
      COLON_RE.lastIndex = end;
      type = COLON_RE.test(text) ? 'key' : 'str';
    } else if (m[2] !== undefined) type = 'num';
    else if (m[3] !== undefined) type = 'lit';
    else type = 'punc';
    tokens.push({ type, start, end });
  }
  return tokens;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const LITERALS = {
  true: 'true', false: 'false', null: 'null',
  True: 'true', False: 'false', None: 'null',
  undefined: 'null', NaN: 'null', Infinity: 'null',
};
const ESCAPES = { '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

// Lexes loosely-written JSON into { t, v } tokens, where v is valid JSON text for values.
function lexLoose(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c) || c === '(' || c === ')' || c === ';') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if ('{}[]:,'.includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let s = '';
      i++;
      while (i < n && text[i] !== c) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < n) {
          const next = text[i + 1];
          if (next === "'" || next === '`') s += next;
          else if ('"\\/bfnrtu'.includes(next)) s += ch + next;
          else s += '\\\\' + next;
          i += 2;
          continue;
        }
        if (ch === '"') s += '\\"';
        else if (ESCAPES[ch]) s += ESCAPES[ch];
        else if (ch < ' ') s += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        else s += ch;
        i++;
      }
      i++;
      out.push({ t: 'str', v: '"' + s + '"' });
      continue;
    }
    NUM_RE.lastIndex = i;
    let m = NUM_RE.exec(text);
    if (m) {
      i += m[0].length;
      out.push({ t: 'num', v: JSON.stringify(Number(m[0])) });
      continue;
    }
    IDENT_RE.lastIndex = i;
    m = IDENT_RE.exec(text);
    if (m) {
      i += m[0].length;
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      // Wrappers such as JSONP callbacks or ObjectId("...") are dropped, keeping their argument.
      if (text[j] === '(') continue;
      if (text[j] !== ':' && LITERALS[m[0]]) out.push({ t: 'lit', v: LITERALS[m[0]] });
      else out.push({ t: 'str', v: JSON.stringify(m[0]) });
      continue;
    }
    i++;
  }
  return out;
}

const isValue = (t) => t === 'str' || t === 'num' || t === 'lit';
const CLOSER = { '{': '}', '[': ']' };

// Rebuilds a token stream into valid JSON text: inserts missing commas/colons, drops stray ones,
// closes unclosed containers and wraps several top-level values in an array.
function rebuild(tokens) {
  const out = [];
  const stack = [];
  let prev = null;
  let expectColon = false;
  let roots = 0;

  const push = (t, v) => {
    out.push(v === undefined ? t : v);
    prev = t;
  };
  const top = () => stack[stack.length - 1];
  const afterValue = () => prev === 'str' || prev === 'num' || prev === 'lit' || prev === '}' || prev === ']';

  // A key without a value gets null.
  function finishMember() {
    if (expectColon) { push(':'); expectColon = false; }
    if (prev === ':') push('lit', 'null');
  }

  function closeTop() {
    if (top() === '{') finishMember();
    if (prev === ',') out.pop();
    push(CLOSER[stack.pop()]);
  }

  for (const tok of tokens) {
    const { t } = tok;
    if (t === ',') {
      if (top() === '{') finishMember();
      if (stack.length && afterValue()) push(',');
      continue;
    }
    if (t === ':') {
      if (expectColon) { push(':'); expectColon = false; }
      continue;
    }
    if (t === '}' || t === ']') {
      const opener = t === '}' ? '{' : '[';
      if (!stack.includes(opener)) continue;
      while (top() !== opener) closeTop();
      closeTop();
      continue;
    }
    if (top() === '{' && !expectColon && prev !== ':') {
      // Key position.
      if (afterValue()) push(',');
      if (t === '{' || t === '[') {
        push('str', '""');
        push(':');
      } else {
        push('str', t === 'str' ? tok.v : JSON.stringify(String(JSON.parse(tok.v))));
        expectColon = true;
        continue;
      }
    }
    if (expectColon) { push(':'); expectColon = false; }
    if (prev !== ':') {
      if (afterValue()) push(',');
      if (stack.length === 0) roots++;
    }
    if (t === '{' || t === '[') {
      push(t);
      stack.push(t);
    } else {
      push(t, tok.v);
    }
  }
  while (stack.length) closeTop();

  const body = out.join('');
  return roots > 1 ? '[' + body + ']' : body;
}

// Returns { ok: true, text } with pretty-printed JSON, or { ok: false, error }.
function repair(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(rebuild(lexLoose(text)));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // A JSON document that was escaped into a string.
  if (typeof value === 'string') {
    try {
      const inner = JSON.parse(value);
      if (inner && typeof inner === 'object') value = inner;
    } catch { /* keep the plain string */ }
  }
  if (value === undefined) return { ok: false, error: 'No JSON found' };
  return { ok: true, text: JSON.stringify(value, null, 2) };
}

globalThis.JsonText = { tokenize, repair };
})();
