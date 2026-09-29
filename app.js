(function () {
const { parse, diff, formatPath } = globalThis.JsonDiff;
const { tokenize, repair } = globalThis.JsonText;
const { createTree } = globalThis.JsonTree;

const LINE_HEIGHT = 20;
// Below this size every keystroke is compared on the next frame; larger documents are debounced.
const INSTANT_LIMIT = 100000;

const EXAMPLE_LEFT = {
  name: 'json-diff-tool',
  version: '1.0.0',
  private: true,
  tags: ['json', 'diff', 'compare'],
  author: { name: 'Jane', email: 'jane@example.com' },
  settings: { theme: 'light', tabSize: 2, autosave: false },
};

const EXAMPLE_RIGHT = {
  name: 'json-diff-tool',
  version: '1.1.0',
  tags: ['json', 'viewer', 'diff', 'compare'],
  author: { name: 'Jane', email: 'jane@example.org' },
  settings: { theme: 'dark', tabSize: 2, autosave: false },
  license: 'MIT',
};

const panes = { left: setupPane('left'), right: setupPane('right') };
const ui = {
  summary: document.getElementById('summary'),
  position: document.getElementById('position'),
  path: document.getElementById('current-path'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  share: document.getElementById('share'),
  toast: document.getElementById('toast'),
};

let diffs = [];
let current = -1;
let timer = 0;
let frame = 0;

function setupPane(side) {
  const root = document.querySelector(`.pane[data-side="${side}"]`);
  const pane = {
    side,
    mode: 'text',
    textarea: root.querySelector('textarea'),
    editor: root.querySelector('.editor'),
    backdrop: root.querySelector('.backdrop-inner'),
    gutter: root.querySelector('.gutter-inner'),
    treeBox: root.querySelector('.tree'),
    treeTools: root.querySelector('.tree-tools'),
    modeButtons: root.querySelectorAll('[data-mode]'),
    status: root.querySelector('[data-role="status"]'),
    text: '',
    error: null,
    root: null,
    tree: null,
  };
  pane.textarea.addEventListener('input', () => {
    clearSharedHash();
    schedule();
  });
  pane.textarea.addEventListener('scroll', () => syncScroll(pane));
  pane.modeButtons.forEach((b) => b.addEventListener('click', () => setMode(pane, b.dataset.mode)));
  root.querySelector('[data-action="repair"]').addEventListener('click', () => repairPane(pane));
  root.querySelector('[data-action="expand"]').addEventListener('click', () => pane.tree && pane.tree.setAll(true));
  root.querySelector('[data-action="collapse"]').addEventListener('click', () => pane.tree && pane.tree.setAll(false));
  return pane;
}

function schedule() {
  clearTimeout(timer);
  cancelAnimationFrame(frame);
  const size = panes.left.textarea.value.length + panes.right.textarea.value.length;
  if (size < INSTANT_LIMIT) frame = requestAnimationFrame(compare);
  else timer = setTimeout(compare, 200);
}

function setMode(pane, mode) {
  pane.mode = mode;
  pane.modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  pane.editor.hidden = mode !== 'text';
  pane.treeBox.hidden = pane.treeTools.hidden = mode !== 'tree';
  renderPane(pane);
}

let toastTimer = 0;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3000);
}

// Replaces the textarea content while keeping it on the browser's undo stack where supported.
function replaceText(textarea, value) {
  if (!textarea.offsetParent) {
    textarea.value = value;
    return;
  }
  textarea.focus();
  textarea.select();
  if (!document.execCommand('insertText', false, value)) textarea.value = value;
}

function repairPane(pane) {
  const before = pane.textarea.value;
  const result = repair(before);
  if (!result.ok) {
    toast(`Could not repair: ${result.error}`);
    return;
  }
  if (result.text === before) {
    toast('Already valid and formatted');
    return;
  }
  replaceText(pane.textarea, result.text);
  clearSharedHash();
  compare();
  toast('Repaired and formatted');
}

// Only the visible lines (plus a buffer) of the backdrop and gutter are rendered, so cost does not grow with document size.
const BUFFER_LINES = 50;
function syncScroll(pane) {
  if (pane.mode !== 'text' || !pane.tokens) return;
  const { textarea: ta, text, starts } = pane;
  const first = Math.max(0, Math.floor(ta.scrollTop / LINE_HEIGHT) - BUFFER_LINES);
  const last = Math.min(starts.length - 1, Math.ceil((ta.scrollTop + ta.clientHeight) / LINE_HEIGHT) + BUFFER_LINES);
  const from = starts[first];
  const to = last + 1 < starts.length ? starts[last + 1] : text.length;
  pane.backdrop.innerHTML = highlightHtml(text, pane.tokens, pane.marks, from, to);
  let gutter = '';
  for (let l = first; l <= last; l++) gutter += `<span class="${pane.lineCls[l]}">${l + 1}</span>`;
  pane.gutter.innerHTML = gutter;
  const y = first * LINE_HEIGHT - ta.scrollTop;
  pane.backdrop.style.transform = `translate(${-ta.scrollLeft}px, ${y}px)`;
  pane.gutter.style.transform = `translateY(${y}px)`;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parsePane(pane) {
  pane.text = pane.textarea.value;
  pane.starts = lineStarts(pane.text);
  pane.error = null;
  pane.root = null;
  try {
    pane.root = parse(pane.text);
  } catch (e) {
    pane.error = e;
  }
}

// Marks for one side: [{ from, to, cls, index }] sorted by offset; ranges never overlap.
function marksFor(pane) {
  if (pane.error) {
    const at = Math.min(pane.error.pos, Math.max(pane.text.length - 1, 0));
    return [{ from: at, to: at + 1, cls: 'error', index: -1 }];
  }
  const own = pane.side === 'left' ? 'removed' : 'added';
  const marks = [];
  diffs.forEach((d, index) => {
    if (d.kind === 'changed' || d.kind === own) {
      const s = d[pane.side];
      marks.push({ from: s.from, to: s.to, cls: d.kind, index });
    }
  });
  return marks.sort((a, b) => a.from - b.from);
}

// Syntax-highlighted HTML for text[from, to) with diff marks wrapped around token spans.
function highlightHtml(text, tokens, marks, from, to) {
  let html = '';
  let pos = from;
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end <= from) lo = mid + 1;
    else hi = mid;
  }
  let ti = lo;
  const emit = (to) => {
    while (pos < to) {
      while (ti < tokens.length && tokens[ti].end <= pos) ti++;
      const t = tokens[ti];
      if (!t || t.start >= to) {
        html += escapeHtml(text.slice(pos, to));
        pos = to;
        return;
      }
      if (t.start > pos) {
        html += escapeHtml(text.slice(pos, t.start));
        pos = t.start;
      }
      const end = Math.min(t.end, to);
      html += `<span class="t-${t.type}">${escapeHtml(text.slice(pos, end))}</span>`;
      pos = end;
    }
  };
  for (const m of marks) {
    if (m.to <= from) continue;
    if (m.from >= to) break;
    emit(Math.max(m.from, from));
    const cls = m.index === current ? `${m.cls} current` : m.cls;
    html += `<mark class="${cls}">`;
    emit(Math.min(m.to, to));
    html += '</mark>';
  }
  emit(to);
  return html;
}

// Tree markers for one side: the node's own diff kind, and which containers hold a diff.
function treeMarkers(pane) {
  const own = pane.side === 'left' ? 'removed' : 'added';
  const kinds = new Map();
  const anchors = new Set();
  for (const d of diffs) {
    const node = d[pane.side].node;
    if (d.kind === 'changed' || d.kind === own) kinds.set(node, d.kind);
    else anchors.add(node);
  }
  const dirty = new Set();
  (function walk(node) {
    let has = kinds.has(node) || anchors.has(node);
    const children = node.type === 'object' ? node.members.map((m) => m.node)
      : node.type === 'array' ? node.items : [];
    for (const c of children) if (walk(c)) has = true;
    if (has) dirty.add(node);
    return has;
  })(pane.root);
  return { kinds, dirty };
}

function renderTree(pane) {
  pane.tree = null;
  if (pane.error || !pane.root) {
    pane.treeBox.replaceChildren();
    const msg = document.createElement('p');
    msg.className = 'tree-empty';
    msg.textContent = pane.error ? 'Invalid JSON. Switch to Text to fix it, or use Repair.' : 'Empty';
    pane.treeBox.append(msg);
    return;
  }
  const { kinds, dirty } = treeMarkers(pane);
  pane.tree = createTree(pane.treeBox, pane.root, kinds, dirty);
  markTreeCurrent(pane, false);
}

function markTreeCurrent(pane, scroll) {
  if (!pane.tree) return;
  pane.treeBox.querySelectorAll('.row.current').forEach((r) => r.classList.remove('current'));
  if (current < 0) return;
  const row = pane.tree.reveal(diffs[current][pane.side].node);
  if (!row) return;
  row.classList.add('current');
  if (scroll) row.scrollIntoView({ block: 'center' });
}

function renderPane(pane) {
  const { text, starts } = pane;
  if (pane.mode === 'text') {
    const marks = marksFor(pane);
    const lineCls = new Array(starts.length).fill('');
    for (const m of marks) {
      if (m.cls === 'error') continue;
      const last = lineOf(starts, Math.max(m.from, m.to - 1));
      for (let l = lineOf(starts, m.from); l <= last; l++) lineCls[l] = m.cls;
    }
    pane.tokens = tokenize(text);
    pane.marks = marks;
    pane.lineCls = lineCls;
  } else {
    renderTree(pane);
  }

  if (pane.error) {
    const line = lineOf(starts, pane.error.pos);
    const col = pane.error.pos - starts[line] + 1;
    pane.status.textContent = `Line ${line + 1}, col ${col}: ${pane.error.message}`;
    pane.status.title = pane.status.textContent;
    pane.status.classList.add('error');
  } else {
    pane.status.textContent = pane.root ? `${starts.length} lines` : 'Empty';
    pane.status.title = '';
    pane.status.classList.remove('error');
  }
  syncScroll(pane);
}

function renderSummary() {
  const { left, right } = panes;
  ui.summary.classList.remove('same');
  if (left.error || right.error) {
    ui.summary.textContent = 'Fix the invalid JSON to compare';
  } else if (!left.root || !right.root) {
    ui.summary.textContent = 'Paste JSON on both sides';
  } else if (diffs.length === 0) {
    ui.summary.textContent = 'No differences';
    ui.summary.classList.add('same');
  } else {
    const count = (k) => diffs.filter((d) => d.kind === k).length;
    ui.summary.textContent = `${diffs.length} difference${diffs.length > 1 ? 's' : ''}: ` +
      `${count('removed')} removed, ${count('added')} added, ${count('changed')} changed`;
  }
  ui.position.textContent = diffs.length ? `${current + 1} / ${diffs.length}` : '0 / 0';
  ui.path.textContent = current >= 0 ? `${diffs[current].kind}: ${formatPath(diffs[current].path)}` : '';
  ui.prev.disabled = ui.next.disabled = diffs.length === 0;
}

function render() {
  renderPane(panes.left);
  renderPane(panes.right);
  renderSummary();
}

function compare() {
  parsePane(panes.left);
  parsePane(panes.right);
  const ok = !panes.left.error && !panes.right.error;
  diffs = ok ? diff(panes.left.root, panes.right.root) : [];
  current = Math.min(current, diffs.length - 1);
  render();
}

function scrollToOffset(pane, offset) {
  const line = lineOf(pane.starts, offset);
  pane.textarea.scrollTop = Math.max(0, line * LINE_HEIGHT - pane.textarea.clientHeight / 3);
}

function goTo(index) {
  if (!diffs.length) return;
  current = (index + diffs.length) % diffs.length;
  const d = diffs[current];
  for (const pane of [panes.left, panes.right]) {
    if (pane.mode === 'text') {
      scrollToOffset(pane, d[pane.side].from);
      syncScroll(pane);
    } else {
      markTreeCurrent(pane, true);
    }
  }
  renderSummary();
}

// Share links carry both documents deflate-compressed in the URL fragment, which is never sent to a server.
function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pack(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function unpack(s) {
  const stream = new Blob([fromBase64Url(s)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function clearSharedHash() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

async function share() {
  const [l, r] = await Promise.all([pack(panes.left.textarea.value), pack(panes.right.textarea.value)]);
  const url = `${location.href.split('#')[0]}#left=${l}&right=${r}`;
  history.replaceState(null, '', url);
  const size = `${Math.ceil(url.length / 1024)} KB`;
  const warn = url.length > 100000 ? ' Very long links may be cut off by chat apps.' : '';
  try {
    await navigator.clipboard.writeText(url);
    toast(`Link copied (${size}).${warn}`);
  } catch {
    toast(`Link is in the address bar (${size}).${warn}`);
  }
}

async function loadShared() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('left') && !params.has('right')) return false;
  try {
    const [l, r] = await Promise.all([unpack(params.get('left') || ''), unpack(params.get('right') || '')]);
    panes.left.textarea.value = l;
    panes.right.textarea.value = r;
    return true;
  } catch {
    toast('The shared link is damaged and could not be opened');
    return false;
  }
}

ui.prev.addEventListener('click', () => goTo(current - 1));
ui.next.addEventListener('click', () => goTo(current + 1));
ui.share.addEventListener('click', share);
window.addEventListener('resize', () => { syncScroll(panes.left); syncScroll(panes.right); });
document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); goTo(current + 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); goTo(current - 1); }
});

loadShared().then((shared) => {
  if (!shared) {
    panes.left.textarea.value = JSON.stringify(EXAMPLE_LEFT, null, 2);
    panes.right.textarea.value = JSON.stringify(EXAMPLE_RIGHT, null, 2);
  }
  compare();
});
})();
