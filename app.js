(function () {
const { parse, diff, formatPath } = globalThis.JsonDiff;

const LINE_HEIGHT = 20;

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
};

let diffs = [];
let current = -1;
let timer = 0;

function setupPane(side) {
  const root = document.querySelector(`.pane[data-side="${side}"]`);
  const pane = {
    side,
    textarea: root.querySelector('textarea'),
    backdrop: root.querySelector('.backdrop-inner'),
    gutter: root.querySelector('.gutter-inner'),
    status: root.querySelector('[data-role="status"]'),
    text: '',
    error: null,
    root: null,
  };
  pane.textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(compare, 200);
  });
  pane.textarea.addEventListener('scroll', () => syncScroll(pane));
  return pane;
}

function syncScroll(pane) {
  const { scrollLeft, scrollTop } = pane.textarea;
  pane.backdrop.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  pane.gutter.style.transform = `translateY(${-scrollTop}px)`;
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

function renderPane(pane) {
  const marks = marksFor(pane);
  const { text, starts } = pane;

  let html = '';
  let pos = 0;
  const lineCls = new Array(starts.length).fill('');
  for (const m of marks) {
    html += escapeHtml(text.slice(pos, m.from));
    const cls = m.index === current ? `${m.cls} current` : m.cls;
    html += `<mark class="${cls}">${escapeHtml(text.slice(m.from, m.to)) || ' '}</mark>`;
    pos = m.to;
    if (m.cls !== 'error') {
      const last = lineOf(starts, Math.max(m.from, m.to - 1));
      for (let l = lineOf(starts, m.from); l <= last; l++) lineCls[l] = m.cls;
    }
  }
  // Trailing space keeps the backdrop as tall as the textarea when the text ends with a newline.
  pane.backdrop.innerHTML = html + escapeHtml(text.slice(pos)) + ' ';
  pane.gutter.innerHTML = lineCls.map((c, i) => `<span class="${c}">${i + 1}</span>`).join('');

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
  render();
  const d = diffs[current];
  scrollToOffset(panes.left, d.left.from);
  scrollToOffset(panes.right, d.right.from);
}

ui.prev.addEventListener('click', () => goTo(current - 1));
ui.next.addEventListener('click', () => goTo(current + 1));
document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); goTo(current + 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); goTo(current - 1); }
});

panes.left.textarea.value = JSON.stringify(EXAMPLE_LEFT, null, 2);
panes.right.textarea.value = JSON.stringify(EXAMPLE_RIGHT, null, 2);
compare();
})();
