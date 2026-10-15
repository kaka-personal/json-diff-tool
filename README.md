# JSON Diff Tool

Compare two JSON documents side by side. Added, removed and changed values are highlighted in place,
and you can step through every difference. Everything runs in the browser; nothing is uploaded.

- Structural diff: object key order is ignored, arrays are aligned with LCS so an insertion does not mark every following item as changed
- Ignore keys by name (anywhere) or by path such as `$.items[*].id`, and optionally ignore array order
- Character-precise highlighting, so minified JSON works too
- Syntax highlighting; only the visible lines are rendered, so large documents stay fast
- Optional word wrap with line numbers that follow wrapped lines (the whole document is rendered in this mode)
- Tree view per pane, with changed nodes marked and their parents expanded
- Open a file or drop one onto either pane
- Copy the differences as an RFC 6902 JSON Patch that turns the original into the modified document
- Share links: both documents are compressed into the URL fragment, which is never sent to a server
- Format or minify either side with 2 spaces, 4 spaces or tabs; only whitespace is rewritten, so big numbers and escapes stay as written
- Repair: fixes single quotes, unquoted keys, trailing commas, comments, Python/JS literals,
  missing commas, truncated documents, JSONP/function wrappers, escaped JSON strings and NDJSON
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
