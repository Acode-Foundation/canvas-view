# canvas-view

A code editor view for [CodeMirror 6](https://codemirror.net) that draws
text with the GPU (WebGL2 or WebGPU) instead of the DOM, and owns its
scrolling with Android's fling physics. Every frame on screen is fully
drawn: no blank areas during fast flings, even on slow Android WebViews.

It runs on CodeMirror's own `EditorState`, languages, commands and UI
plugins (search, autocomplete, lint, tooltips, panels), so most
CodeMirror code works unchanged. It was built for
[Acode](https://github.com/Acode-Foundation/Acode), the Android code
editor, and is usable as a standalone library.

> **Experimental.**

## Why

DOM editors lay out and render text on the main thread. CodeMirror lets
the compositor scroll, so when the main thread is busy (a language
server, a slow CPU, many decorations) a fast fling reaches lines that
haven't been rendered yet. Ace and Monaco scroll from JavaScript and drop
frames instead.

canvas-view keeps text, selection, gutter and decorations in GPU buffers
it updates incrementally. A scroll frame only changes a few offsets, so
the picture always matches the scroll position, and CodeMirror's UI
still runs as real DOM over and around the canvas.

On a phone (Motorola Edge 40 Neo, Android System WebView, 90Hz) with a
120,000-line JavaScript file, CPU slowed 6× to approximate a low-end
device:

| | canvas-view | CodeMirror 6 | Ace | Monaco |
| --- | --- | --- | --- | --- |
| Fling frame p95 / worst | 11.2 / 11.3ms | 11.2 / 110.9ms | 55.4 / 66.7ms | 33.3 / 55.5ms |
| Frames with blank areas | 0 | 5 | 0 | 0 |
| Main-thread time per scroll frame | 6.3ms | 10.6ms | 37.4ms | 64.1ms |
| Typing latency p50 / p95 | 36 / 68ms | 62 / 80ms | 53 / 63ms | 51 / 64ms |
| JS heap | 11 MB | 10 MB | 26 MB | 40 MB |

11.1ms is a perfect frame at 90Hz. Reproduce with
`node bench/compare.mjs --device` (see [Development](#development)).

## Install

```sh
npm install @acode.app/canvas-view @codemirror/state @codemirror/view @codemirror/language
```

Your app must end up with a single copy each of `@codemirror/state`,
`@codemirror/view`, `@codemirror/language` and `@lezer/common` (1.5.4 or
later), as CodeMirror requires.

## Usage

```ts
import {EditorState} from "@codemirror/state"
import {javascript} from "@codemirror/lang-javascript"
import {CanvasView, darkTheme} from "@acode.app/canvas-view"

const view = new CanvasView({
	parent: document.querySelector("#editor")!,
	state: EditorState.create({doc: "console.log('hi')", extensions: [javascript()]}),
	theme: darkTheme,
	font: {family: "monospace", size: 14},
	lineWrapping: true,
	stickyScroll: true
})

view.dispatch({changes: {from: 0, insert: "// hello\n"}})
view.reconfigure({rainbowBrackets: true})
```

To CodeMirror code, `view` behaves like an `EditorView` (`state`,
`dispatch`, `coordsAtPos`, `posAtCoords`, `lineBlockAt`, `dom`,
`scrollDOM`, `plugin()`, `requestMeasure()`...), and
`view instanceof EditorView` is true. `@codemirror/commands` and keymaps
run against it unchanged.

## Features

- **Rendering:** WebGL2 (default) or WebGPU, recovering from GPU context
  loss by itself. Unicode: CJK, emoji and ZWJ sequences, combining marks,
  shaped Arabic, Hebrew, Indic and Thai words. Right-to-left text ordered
  by the Unicode Bidi Algorithm, with `ltr`, `rtl` and per-line `auto`
  paragraphs.
- **Syntax highlighting** from any `@codemirror/language` language,
  parsed in time slices that never block a frame. Colors come from the
  state's `syntaxHighlighting(...)` styles, so they match the DOM editor.
- **Scrolling:** Android `OverScroller` flings, 1:1 drags, wheel,
  adjustable speed and scroll-past-end.
- **Layout:** line wrapping with VS Code-like breaks and continuation
  indent, folding, sticky scroll, inline widgets, block widgets and block
  replaces (real DOM in rows of their own).
- **Editing:** EditContext input with IME composition (textarea
  fallback), CodeMirror keymaps, history, closeBrackets, multiple cursors,
  rectangular selection, text drag-and-drop, read-only modes.
- **Touch:** selection handles, long press, double and triple tap, edge
  autoscroll, on-screen keyboard handling. The selection menu is yours,
  driven by hooks.
- **Drawn natively:** line numbers (absolute or relative), fold markers,
  active line, indent guides, rainbow brackets, whitespace markers, lint
  underlines, search highlights, and gutter markers from CodeMirror's
  `gutter()`.

## Options

| Option | Default | |
| --- | --- | --- |
| `parent` | | Element to append `view.dom` to |
| `state` / `doc` / `extensions` | | The `EditorState`, or a doc and extensions to make one |
| `theme` | `darkTheme` | A `CanvasThemeSpec` (see [Theming](#theming)) |
| `font` | monospace, 14px | `{family, size, lineHeight}`. Without `lineHeight`, rows are as tall as CodeMirror's (`.cm-line` CSS line height) |
| `fontLigatures` | from the CSS (on) | Draw the font's ligatures (`=>`, `!==`) like DOM text; off with `false`, or with `font-variant-ligatures: none` in the editor's CSS |
| `backend` | `"auto"` (WebGL2) | `"webgl2"` or `"webgpu"` (falls back to WebGL2) |
| `lineNumbers` | `true` | `false` or `"relative"` |
| `onLineNumberClick` | fold toggle | `(line, event, view) => boolean`; return true to handle it |
| `foldMarkers` | `"fade"` | `"always"` or `"none"` |
| `stickyScroll` | `false` | `true`, or `{maxLines}` (default 5) |
| `lineWrapping` | from `EditorView.lineWrapping` | |
| `wrapIndent` | `"same"` | `"none"`, `"indent"`, `"deepIndent"`, or extra columns |
| `textDirection` | `"ltr"` | `"rtl"`, or `"auto"` (per line; default with `EditorView.perLineTextDirection`) |
| `indentGuides` | `true` | `false`, or `{active, hideOnBlankLines}` |
| `rainbowBrackets` | `false` | `true`, or `{colors}` |
| `showWhitespace` | auto | `true`, `false`, or `{spaces, trailing, lineBreaks}`; on with `highlightWhitespace()` |
| `gutterMarkers` | `"shared"` | `"columns"` (one per `gutter()`) or `"overlay"` (over the line numbers) |
| `highlightActiveLine` | `true` | |
| `cursorWidth` | `2` | CSS px |
| `cursorBlinkRate` | `1200` | ms, `0` to disable |
| `readOnlyCursor` | `true` | Steady cursor in non-editable views |
| `placeholder` | | Shown while the document is empty |
| `scrollSpeed` | `"normal"` | `"slow"`, `"fast"`, `"fastX2"`, or a multiplier |
| `scrollPastEnd` | `true` | Or a fraction of the view height (`0.25`, `0.5`, `1`) |
| `horizontalScrollPastEnd` | `0` | Extra px of horizontal room |
| `tabSize` | from the state | |
| `input` | `"auto"` | `"editcontext"` or `"textarea"` |
| `touchSelection` | | `{handleSize, cursorHandleTimeout, onMenu, onHaptic, wordRange}` |
| `lowLatency` | `false` | Request a desynchronized canvas |
| `dispatchTransactions` | | Like CodeMirror's |

## API

Besides the `EditorView` members:

| | |
| --- | --- |
| `view.reconfigure(options)` | Change display options live |
| `view.setState(state)` | Switch documents (editor tabs); keeps each document's parse, so switching back is instant |
| `view.setTheme(spec)` / `view.setFont(font)` | Change the theme or font |
| `view.touchSelection.openMenu()` / `hideMenu()` | For toolbar buttons that open your selection menu |
| `view.destroy()` | Release the GPU context and listeners. Browsers allow ~16 WebGL contexts per page, so destroy views you no longer show |

## Theming

A `CanvasThemeSpec` has colors (`background`, `foreground`, `selection`,
`cursor`, `activeLine`, gutter colors, `indentGuide`,
`stickyBackground`...), `dark`, an optional `highlight` (a CodeMirror
`HighlightStyle`, used when the state has no `syntaxHighlighting`), and
`classes`, which give mark decorations a canvas style by class name.
`darkTheme` and `lightTheme` are exported. Keep your
`EditorView.theme(...)` extensions in the state too: they style the DOM
parts (tooltips, panels, autocomplete).

### Decorations and widgets

```ts
// Mark styles come from the theme's `classes`, built-in defaults for
// CodeMirror's own classes, or the decoration itself.
Decoration.mark({class: "my-match", canvas: {background: "#ff03", underline: "wavy", underlineColor: "red"}})

// Inline widgets draw their toDOM() text by default, or draw themselves.
class Swatch extends WidgetType {
	toDOM() { return document.createElement("span") }
	toCanvas() {
		return {text: "", cells: 2, key: "swatch-red", draw: (cx, w, h) => {
			cx.fillStyle = "red"
			cx.fillRect(0, h * 0.2, w, h * 0.6)
		}}
	}
}

// Block widgets are real DOM in rows of their own.
Decoration.widget({widget: new CodeLens(), block: true, side: -1})
```

### Touch selection menu

```ts
new CanvasView({
	touchSelection: {
		onMenu: e => e.type == "show" ? myMenu.showAt(e.selectionRect, e.trigger) : myMenu.hide(),
		onHaptic: () => navigator.vibrate?.(20)
	}
})
```

## CodeMirror compatibility

- **Unchanged:** `EditorState`, transactions, facets, StateFields,
  history, commands, languages, `HighlightStyle`s, and the logic of
  autocomplete, lint, search and LSP clients.
- **Hosted:** `ViewPlugin`s, update listeners, `domEventHandlers`,
  tooltips, panels and dialogs, the autocomplete popup, lint (with
  `lintGutter()`), `gutter()`, `EditorView.decorations` (marks, line
  decorations, inline and block widgets, replaced ranges),
  `atomicRanges`, `EditorView.theme`, `editable`, `readOnly`,
  `lineWrapping`, `rectangularSelection`, `crosshairCursor`,
  clipboard filters.
- **Drawn natively instead** (these plugins are skipped):
  drawSelection, lineNumbers, foldGutter, highlightActiveLine,
  highlightSpecialChars, highlightWhitespace, dropCursor, and
  CodeMirror's background parse worker.
- **Not supported:** DOM inside the text (and `domAtPos`), explicit bidi
  embeddings and isolates, screen readers, proportional fonts.

## Browser support

Needs WebGL2 or WebGPU. Developed and tested in Chromium (desktop Chrome
and Android System WebView). Input uses EditContext where available
(Chrome 121+) and a hidden textarea elsewhere. Firefox and Safari aren't
tested yet.

## Development

```sh
bun install
bun run demo           # http://127.0.0.1:5173
bun run check          # TypeScript
bun run test           # unit tests
bun run test:browser   # browser tests, both backends
bun run bench          # fling benchmark vs CodeMirror 6
```

The demo has a ⚙ panel for every option and loads CodeMirror's search,
autocomplete, lint and folding. `cm.html`, `ace.html` and `monaco.html`
show the same file in the other editors. Browser tests and benchmarks
launch Chromium through Puppeteer: pass `--browser=<path>` or set
`CHROME_PATH`.

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) first:
it covers the architecture and the performance rules, which are the
point of the project.

## License

MIT, see [LICENSE](LICENSE). Parts are derived from CodeMirror (MIT) and
from AOSP's `OverScroller` (Apache 2.0); see [NOTICE](NOTICE).
