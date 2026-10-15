# JSON Diff Tool

Compare two JSON documents side by side. Added, removed and changed values are highlighted in place,
and you can step through every difference. Everything runs in the browser; nothing is uploaded.

- Structural diff: object key order is ignored, arrays are aligned with LCS so an insertion does not mark every following item as changed
- Character-precise highlighting, so minified JSON works too
- Only the visible lines are rendered, so large documents stay fast
- Tree view per pane, with changed nodes marked and their parents expanded
- Share links: both documents are compressed into the URL fragment, which is never sent to a server
- Format or minify either side with 2 spaces, 4 spaces or tabs; only whitespace is rewritten, so big numbers and escapes stay as written
- Syntax errors are reported with line and column
- Zero dependencies, no build step

## Usage

Paste JSON into both panes. Use the arrow buttons (or `Alt+↑` / `Alt+↓`) to jump between differences.
`Shift+Alt+F` formats the editor that has focus.

## Development

```bash
python -m http.server 5178
```

Then open http://localhost:5178. Run the tests with `npm test` (Node 18+).
