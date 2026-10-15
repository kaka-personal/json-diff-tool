// Read-only, lazily rendered tree view of a parsed JSON node with diff markers.
// Plain script (no ES module) so the page also works when opened from file://.
(function () {

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function valueText(node) {
  return node.type === 'string' ? JSON.stringify(node.value) : String(node.value);
}

const TYPE_CLASS = { string: 't-str', number: 't-num', boolean: 't-lit', null: 't-lit' };

// kinds: Map(node -> 'added' | 'removed' | 'changed'); dirty: Set of nodes that contain a diff.
function createTree(container, root, kinds, dirty) {
  const rows = new Map();
  const parents = new Map();
  const renderers = new Map();

  (function link(node) {
    const children = node.type === 'object' ? node.members.map((m) => m.node)
      : node.type === 'array' ? node.items : [];
    for (const c of children) {
      parents.set(c, node);
      link(c);
    }
  })(root);

  function label(row, key, isIndex) {
    if (key === undefined) return;
    row.append(el('span', isIndex ? 't-index' : 't-key', isIndex ? String(key) : JSON.stringify(key)), el('span', 't-punc', ': '));
  }

  function render(node, key, isIndex, depth) {
    const kind = kinds.get(node);
    if (node.type !== 'object' && node.type !== 'array') {
      const row = el('div', 'row leaf');
      label(row, key, isIndex);
      row.append(el('span', TYPE_CLASS[node.type], valueText(node)));
      if (kind) row.classList.add(kind);
      rows.set(node, row);
      return row;
    }
    const isObj = node.type === 'object';
    const count = isObj ? node.members.length : node.items.length;
    const details = el('details', 'branch');
    const summary = el('summary', 'row');
    label(summary, key, isIndex);
    summary.append(el('span', 't-punc', isObj ? '{' : '['), el('span', 'count', ` ${count} ${isObj ? 'keys' : 'items'} `), el('span', 't-punc', isObj ? '}' : ']'));
    if (kind) summary.classList.add(kind);
    if (dirty.has(node)) summary.classList.add('dirty');
    details.append(summary);
    rows.set(node, summary);

    let rendered = false;
    const renderChildren = () => {
      if (rendered) return;
      rendered = true;
      const box = el('div', 'children');
      if (isObj) node.members.forEach((m) => box.append(render(m.node, m.key, false, depth + 1)));
      else node.items.forEach((item, i) => box.append(render(item, i, true, depth + 1)));
      details.append(box);
    };
    renderers.set(node, renderChildren);
    details.addEventListener('toggle', () => details.open && renderChildren());
    if (depth === 0 || (dirty.has(node) && !kind)) {
      renderChildren();
      details.open = true;
    }
    return details;
  }

  container.replaceChildren(render(root, undefined, false, 0));

  return {
    // Expands ancestors so the node is visible, then returns its row element.
    reveal(node) {
      const chain = [];
      for (let p = parents.get(node); p; p = parents.get(p)) chain.unshift(p);
      for (const p of chain) {
        renderers.get(p)();
        rows.get(p).parentElement.open = true;
      }
      return rows.get(node);
    },
    setAll(open) {
      container.querySelectorAll('details').forEach((d) => {
        if (open) {
          d.open = true;
        } else if (d.parentElement !== container) {
          d.open = false;
        }
      });
    },
  };
}

globalThis.JsonTree = { createTree };
})();
