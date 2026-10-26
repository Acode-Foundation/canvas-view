# AGENTS.md

Guide for contributors (people and coding agents) to canvas-view: a code
editor **view** that draws text with the GPU (WebGL2 or WebGPU) and owns
its own scrolling, built on CodeMirror 6's **state** and **language**
packages.

Read this before changing anything. The performance rules are the point
of the project: breaking them to add a feature is a regression.

## The idea

DOM editors fall behind fast flings on slow devices (Android WebView in
particular): the compositor scrolls into lines the main thread hasn't
rendered yet, and the user sees blank areas. canvas-view never uses the
DOM for text. Glyphs, selection, gutter and decorations live in GPU
instance buffers that are updated incrementally, and the view scrolls
itself, so what's drawn always matches the scroll position.

Compatibility stops at the text. CodeMirror's state and language
packages run unchanged, and so do its *UI* view plugins (tooltips,
panels, autocomplete, lint, search, gutter markers, block widgets),
because those are DOM around or over the canvas, never inside the text.

Non-goals: accessibility (screen readers), DOM inside the text or DOM
measurement (`domAtPos`), proportional fonts (layout is a monospace cell
grid), explicit bidi embeddings and isolates.

## Commands

Use **bun**.

```sh
bun install
bun run check          # TypeScript (tsc --noEmit)
bun run test           # unit tests (test/*.test.ts)
bun run test:browser   # browser suites on both backends, with real touch/mouse/key/IME events
bun run demo           # demo at http://127.0.0.1:5173 (index.html = canvas-view, cm.html = CodeMirror)
bun run demo:lan       # same on 0.0.0.0:5199, for phones on the LAN
bun run build          # dist/
bun run bench          # fling benchmark vs CodeMirror 6
node bench/worst.mjs --backend=webgpu --cpu=6   # slowest frames, split by phase: start here for spikes
node bench/compare.mjs --cpu=1,4,6              # vs CodeMirror 6, Ace and Monaco
```

Browser tests and benchmarks launch Chromium through Puppeteer. Pass
`--browser=<path>` or set `CHROME_PATH` to choose the binary (the default
is Playwright's cached "Chrome for Testing" on macOS). Benchmarks emulate
a 412×860 phone at DPR 2.625 with touch and throttle the CPU through CDP.
`--device` variants drive a USB-connected phone's WebView over DevTools
(see the comment at the top of each script).

Demo URL params: `?kind=js|html|unicode|rtl|longline|deep&lines=N&backend=webgl2|webgpu&input=auto|editcontext|textarea&bare=1&wrap=1&ext=full|basic&sticky=0|1|3|5&font=system|fira&ligatures=auto|1|0`.
The ⚙ panel (`demo/settings.ts`) edits every option. In the page,
`window.view` is the `CanvasView` (`view.debug`, `view.stats`,
`view.fling(vx, vy)`) and `window.cmApi` exposes CodeMirror helpers for
tests.

## Code layout

```
src/
  index.ts         public exports
  core/            DOM-free and worker-safe. Never import from view/ here.
    color.ts       CSS color → packed 0xAABBGGRR
    metrics.ts     font measurement → cell and line sizes
    atlas.ts       glyph atlas: per-font-variant coverage masks, shelf packing
    instances.ts   growable instance buffers, instance formats
    backend.ts     RenderBackend interface, DrawPass
    webgl2.ts      WebGL2 backend
    webgpu.ts      WebGPU backend
  view/
    view.ts        CanvasView: state, geometry, frame loop, selection layers, EditorView surface
    scene.ts       incremental per-visual-line glyph/rect segments
    lines.ts       visual lines (widgets, replaced ranges, folds), wrapping, row geometry
    rowmap.ts      chunked rows-per-line counts
    layout.ts      line clusters: graphemes, tabs, control chars, shaped runs
    bidi.ts        Unicode Bidi Algorithm, run reordering, visual cursor motion
    syntax.ts      time-sliced Lezer parsing and highlight runs
    highlight.ts   token colors from the state's highlighters and their CSS
    decorations.ts EditorView.decorations → mark styles, points, joins, widget labels
    compat.ts      hosts CodeMirror ViewPlugins, ViewUpdates, measure requests, themes
    gutters.ts     CodeMirror gutter() configs → drawn marker columns
    blocks.ts      block widgets' DOM over their reserved rows
    brackets.ts    rainbow bracket depths from the syntax tree
    sticky.ts      sticky scroll scopes and header slots
    input.ts       EditContext input (+ textarea fallback), keymaps, clipboard
    touchselect.ts touch selection: taps, long press, handles, menu/haptic hooks
    magnifier.ts   loupe over the text under a finger dragging a selection
    mouse.ts       mouse selection, rectangular selection, text drag-and-drop
    atomic.ts      EditorView.atomicRanges for cursors and pointer selections
    scroll.ts      touch drag, fling, wheel
    spline.ts      Android OverScroller spline + velocity tracker (AOSP-derived, see NOTICE)
    theme.ts       CanvasTheme
demo/              demo pages, fixture generator, CodeMirror/Ace/Monaco comparison pages
bench/             benchmarks (harness.mjs is the shared server and launcher)
test/              unit tests; test/browser/ holds the browser suites
```

## Architecture

### Frame pipeline

`requestFrame()` coalesces into one `requestAnimationFrame`. Each frame:

1. `scroller.step(time)` advances fling momentum. Position is a function
   of time, so a slow frame never shortens a fling.
2. `ensureScene()` makes the visible lines current in the incremental
   scene, then margin lines (scroll direction first) within a 4ms budget.
   Each visual line is a *segment* of glyph/rect instances. Lines in the
   scene's ready range are skipped without a lookup, so a steady frame
   does no scene work. Stale segments are blanked and reclaimed by
   in-place compaction. Edits shift segments in place and re-emit only
   changed lines.
3. `buildDynamic()` rebuilds the selection layers (active line,
   selection, cursor, IME underline) only when the selection, document or
   visible window changes.
4. `backend.syncAtlas()` uploads only the atlas's dirty rectangle.
5. `backend.render(background, passes)`: about ten instanced draws.

A pure scroll frame changes only pass offsets (uniforms). It uploads
nothing, emits nothing and runs no layout.

### Coordinates and geometry

- The JS side works in **CSS pixels**. Shaders multiply by DPR and snap
  glyph origins and rect edges to device pixels. A position and its pass
  offset are snapped separately, so rows keep their spacing while
  scrolling.
- Cell width is an integer number of device pixels. Line height is the
  DOM's exact (fractional) value, measured on a hidden `.cm-line`, so
  line N sits where CodeMirror would put it. Glyph slots map 1:1 onto
  atlas texels with `NEAREST` sampling: never introduce fractional
  device-pixel glyph scaling.
- Geometry is in **rows**: row `r` has top `rowsTop + r * lineHeight`.
  `lines.rowOf(n)` / `lines.lineAtRow(r)` map lines and rows (identity
  without wrapping or folding). `view.posCoords(pos, side)` and
  `view.posAtRow(row, x)` are the primitives everything else builds on.
- Scene instances are relative to `scene.origin`, re-based when far
  away, so float32 precision holds in million-line documents.
- Columns may be fractional: fallback-font glyphs (CJK, emoji) and shaped
  runs use their real advance.

### Rendering

- Glyph instance (20 bytes): `x, y` f32, `u, v, w, h` u16 atlas texels,
  RGBA tint (a tint of 0 marks a color glyph). Rect instance (20 bytes):
  `x, y, w, h` f32, packed RGBA. Backends upload only
  `[dirtyFrom, count)`.
- Passes, in order: under (active line, selection) → text rects → text
  glyphs → over (IME underline, drop cursor) → cursor → gutter → line
  numbers → sticky lines → handles → scrollbar thumbs. Every pass draws
  its whole buffer with an offset and an optional clip.
- WebGL2 uses a single shader program for both instance kinds (each
  program costs a phone driver several ms to compile on first draw).
  WebGPU records a render bundle with indirect draws once; a normal frame
  is one uniform write plus `executeBundles`. Indirect args must be fully
  written (firstVertex and firstInstance 0).
- The atlas stores **coverage masks per font variant**, tinted in the
  shader, so syntax colors don't multiply entries. Slots fit each glyph's
  ink bounds. ASCII has an array fast path. Only dirty rectangles are
  uploaded, straight from the canvas (no JS readback).
- **GPU context loss** is recovered automatically: a restored WebGL2
  context re-uploads everything; an unrestored one (after 2s) or a lost
  WebGPU device gets a fresh canvas and backend. The scene is CPU-side and
  survives. Replacements back off so views can't thrash each other.

### Text layout and bidi

- Printable-ASCII lines skip layout (column == offset). This is the hot
  path: keep it allocation-free.
- Other lines become cached clusters: graphemes, tabs (stopping at screen
  columns, like Chromium), control pictures, and **shaped runs** (a word
  of Arabic, Hebrew, Indic, Thai... rasterized as one glyph so the browser
  shapes it).
- Right-to-left text is ordered by the Unicode Bidi Algorithm per wrapped
  row. Lines in a left-to-right paragraph without RTL characters have
  `vl.bidi == null` and pay nothing. Cursor motion is visual, like
  CodeMirror's.
- **Ligatures** (`fontLigatures`, following the CSS by default, like DOM
  text): runs of punctuation are drawn as one atlas glyph shaped by the
  browser when the font draws them differently from their characters
  (found once per font by pixel comparison, after the frame). Columns
  don't change; a run spanning colors is cut at character boundaries.
  Fonts without ligatures pay nothing.

### Lines, wrapping, folding

- A visual line (`VLine`) is a document line, or several joined by a
  replaced range across line breaks (a fold). `pieces` is null in the
  common case, so the ASCII path stays arithmetic.
- Wrapping breaks around operators and brackets, never inside words or
  before closing punctuation; continuation rows are indented by
  `wrapIndent`. test/wrap.test.ts covers the rules.
- Rows per line live in `RowMap` (chunked counts with lazy prefix sums).
  With wrapping, off-screen chunks are measured in idle slices. When rows
  above the top line change, the view keeps that line in place and
  shifts an ongoing fling.
- Folding is CodeMirror's own: folds are replace decorations.
- Block widgets get rows of their own; their real DOM sits in a layer
  over the canvas and only visible ones are positioned.

### Syntax highlighting

`SyntaxDriver` runs Lezer itself, time-sliced on a MessageChannel
scheduler (8ms idle, 3ms while scrolling, one slice per frame while the
user scrolls or types). Visible lines get colors from the incremental
parse, from standalone **window parses** when the viewport is far beyond
it, or from **stale runs** kept across edits, so typing never flashes
uncolored text. The driver adopts the tree CodeMirror's language field
already reparsed for each transaction (one parse per edit) and shares
its own tree with the state, so `syntaxTree(state)` users see the whole
parse. Lines whose syntax subtrees were reused keep their highlighting
across edits. Requires `@lezer/common` ≥ 1.5.4; keep a single copy of it
installed.

### CodeMirror compatibility

- The view hosts real `ViewPlugin`s (read from CodeMirror's `viewPlugin`
  facet), runs `update(ViewUpdate)`, update listeners, event handlers and
  observers, and `requestMeasure` (after the frame, only when requested).
- `view.dom` is `.cm-editor`, `scrollDOM` a real `.cm-scroller` whose
  `scrollTop`/`scrollTo` are routed to the view. Panels and tooltips are
  DOM.
- The reported `viewport` extends 2.5 screens past the visible rows and
  moves about once per screenful, so viewport-driven plugins update
  rarely and lines have their decorations when first drawn.
- Plugins the canvas replaces are skipped: drawSelection, active line,
  gutters/lineNumbers/foldGutter, special chars, whitespace, dropCursor,
  placeholder, scrollPastEnd, `syntaxHighlighting`'s tree highlighter, and
  CodeMirror's parse worker.
- `@codemirror/view` is a dependency for facets and helpers only. Never
  construct an `EditorView`. `view instanceof EditorView` is true for a
  `CanvasView`, because `@codemirror/commands` checks it.

### Input, touch, mouse

- **EditContext** where available, mirroring a ±10k-char window around
  the selection; a hidden **textarea** otherwise. Typed text goes through
  `EditorView.inputHandler`, keys through CodeMirror's keymap facet.
- `touch-action: none`: the view handles every pointer event and never
  uses native overflow scrolling, so **blank frames are impossible by
  construction**. Drags follow the finger 1:1; flings use Android's
  `OverScroller` spline and LSQ2 velocity tracker, and repeated flicks
  add up (Android's flywheel): a touch moving along a running fling
  keeps it, and the next flick adds its velocity.
- Touch selection mechanics (handles, long press, double/triple tap) are
  the library's; the **menu is the consumer's**, driven by `onMenu`.
- A **magnifier** (`touchSelection.magnifier`, default on) shows the text
  under a finger dragging a handle or a long-press selection, like
  sora-editor's: a small 2D canvas copying the region from the GPU
  canvas right after each frame (only then can a GPU canvas be read).
  It hides in the top and bottom auto-scroll zones.
- A touch selection (handles shown) draws no cursor, like sora-editor
  and native Android; mouse and keyboard selections keep CodeMirror's
  cursor at the head.
- Mouse selection follows CodeMirror's `MouseSelection`, including
  `mouseSelectionStyle` providers; text drag-and-drop is native HTML DnD.

## Performance rules (hard requirements)

1. **No DOM reads or writes in the frame loop**, except the canvas.
   Geometry is arithmetic. `getBoundingClientRect` is only allowed in
   coordinate APIs (`posAtCoords`, `coordsAtPos`) and resize handling.
2. **Pure scroll frames upload nothing and rebuild nothing.** Only pass
   offsets change. A new layer is either static (rebuilt when its content
   changes) or dynamic (rebuilt per frame, and tiny).
3. **No per-glyph allocation** in scene building. Write straight into
   instance buffer views. No closures, regexes or string slicing per
   character on the ASCII path.
4. **Never block a frame on parsing.** Draw plain or stale text until
   colors arrive. Never gate scrolling on rendering.
5. **Never shorten a fling** because of slow frames.
6. **`core/` stays DOM-free** (OffscreenCanvas only), so the renderer can
   move into a worker.
7. **Measure before and after** any change to scene building, the atlas,
   the syntax driver or scrolling (`bun run bench` at 1×/4×/6×), and put
   the numbers in the PR.

## Testing

- `bun run check`, `bun run test` and `bun run test:browser` must pass.
- Changes to layout, geometry, scrolling or input need a browser test
  (usually `test/browser/cursor.mjs` or `test/browser/input.mjs`). The
  cursor suite checks the drawn cursor's pixels, not just the selection,
  which catches backend bugs.
- When behavior should match CodeMirror, compare against a real
  `EditorView` on `demo/cm.html` (`window.cmLib`).
- Headless runs only approximate a phone. Confirm important changes on a
  real Android device.

## Code style

- Tabs, no semicolons, double quotes, `///` doc comments on public API
  (CodeMirror style). Lowercase or camelCase `.ts` filenames.
- `strict` TypeScript.
- Comment *why*, not *what*, and keep comments current.
- Don't add `"sideEffects": false` to package.json: `bun build` then
  emits an empty bundle.
- Scripted edits (sed, Python) must assert their anchor exists.
- [Conventional Commits](https://www.conventionalcommits.org) (`feat:`,
  `fix:`, `perf:`, `refactor:`...).
