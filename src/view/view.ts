import {codeFolding, foldable, foldedRanges, foldEffect, foldState, getIndentUnit, Language, ParseContext, syntaxTree, unfoldEffect} from "@codemirror/language"
import {TreeFragment} from "@lezer/common"
import {type ChangeDesc, CharCategory, EditorSelection, EditorState, type Extension, findClusterBreak, type SelectionRange,
	StateEffect, type StateEffectType, Transaction, type TransactionSpec} from "@codemirror/state"
import {BidiSpan, BlockType, Direction, EditorView, type GutterMarker, gutterLineClass, lineNumberMarkers, type ViewPlugin, type WidgetType} from "@codemirror/view"
import {fontVariant, type FontVariant, type GlyphEntry, GlyphAtlas} from "../core/atlas"
import {deviceSize, type BackendKind, type DrawPass, type RenderBackend} from "../core/backend"
import {type PackedColor, parseColor} from "../core/color"
import {GLYPH_STRIDE, InstanceBuffer, pushGlyph, pushRect, RECT_STRIDE} from "../core/instances"
import {type FontMetrics, type FontSpec, measureFont} from "../core/metrics"
import {WebGL2Backend} from "../core/webgl2"
import {WebGPUBackend} from "../core/webgpu"
import {darkRainbow, lightRainbow, RainbowBrackets} from "./brackets"
import {domViews, type MeasureRequest, nativeEquivalents, PluginHost, wantsLineWrapping} from "./compat"
import {skipAtomicRanges, skipAtomsForSelection} from "./atomic"
import {BlockLayer} from "./blocks"
import {type CanvasWidgetSpec, DecoState, type PointDeco} from "./decorations"
import {Gutters} from "./gutters"
import {createInput, type InputHost, type TextInput} from "./input"
import {ClusterKind, LineLayouts} from "./layout"
import {lineSide, moveVisually, rtlChars} from "./bidi"
import {LineModel, PieceKind, type TextDirectionMode, type VLine, type WrapIndent} from "./lines"
import type {RowMap} from "./rowmap"
import {basicMouseSelection, type MouseHost, MouseSelection, type MouseSelectionStyle, TextDragDrop} from "./mouse"
import {Scene, sameRuns, type TextStyle, type TokenDeco} from "./scene"
import {ScrollController, type ScrollHost} from "./scroll"
import {ScopeFinder, type StickyHeaders, type StickyRows} from "./sticky"
import {type LineRuns, SyntaxDriver} from "./syntax"
import {CanvasTheme, type CanvasThemeSpec, darkTheme} from "./theme"
import {ClassStyleReader, sameHighlighters, stateHighlighters} from "./highlight"
import type {Highlighter} from "@lezer/highlight"
import {TouchSelection, type TouchSelectionConfig} from "./touchselect"
import {Magnifier} from "./magnifier"

export interface CanvasViewConfig {
	parent?: HTMLElement
	state?: EditorState
	doc?: string
	extensions?: Extension
	/// Font family and size in CSS pixels. Without a `lineHeight`, rows
	/// are as tall as a `.cm-line`'s CSS line height, like CodeMirror's
	/// (1.4 from its base theme, or what an `EditorView.theme` sets on
	/// the scroller, content or lines; one on the editor itself doesn't
	/// reach them).
	font?: Partial<FontSpec>
	/// Draw the font's ligatures (`=>`, `!==`, `<=`...) and contextual
	/// alternates, as the browser does in DOM text. By default this
	/// follows the editor's CSS like CodeMirror's text does: on, unless
	/// `font-variant-ligatures` is `none` or `no-contextual`, or
	/// `font-feature-settings` turns `calt` off, on `.cm-content` or
	/// `.cm-line` (e.g. through `EditorView.theme`). Fonts without
	/// ligatures cost nothing either way.
	fontLigatures?: boolean
	theme?: CanvasThemeSpec
	/// Which GPU API to use. "auto" uses WebGL2, the most widely
	/// available; "webgpu" falls back to WebGL2 when unavailable.
	backend?: "auto" | BackendKind
	/// Line numbers: true, false, or "relative" (distance from the
	/// cursor line, which shows its own number).
	lineNumbers?: boolean | "relative"
	/// Called when a line number is tapped/clicked (before the default,
	/// which toggles the line's fold). Return true to handle it.
	onLineNumberClick?: (line: number, event: Event, view: CanvasView) => boolean
	/// Highlight the cursor line and its number (default true).
	highlightActiveLine?: boolean
	/// Cursor width in CSS px (default 2).
	cursorWidth?: number
	/// Draw the cursor, without blinking, in a view that can't take
	/// focus (`EditorView.editable` false, e.g. a read-only file), so a
	/// tap shows where it went, like VS Code's read-only editors and
	/// Acode's DOM editor. Default true.
	readOnlyCursor?: boolean
	/// Text shown while the document is empty.
	placeholder?: string
	/// Color brackets by nesting depth (from the syntax tree, skipping
	/// strings and comments). Default false.
	rainbowBrackets?: boolean | {colors?: readonly string[]}
	/// Gutter markers from CodeMirror `gutter()` configs (lint,
	/// breakpoints...): "shared" (default) puts them all in one narrow
	/// column (the first gutter's marker wins on a line); "columns" gives
	/// each gutter its own column, like CodeMirror; "overlay" adds no
	/// column: a line's marker is drawn in the space left of its number
	/// (over the number's start when it's as wide as the gutter), and
	/// taps or hovers left of the number go to the marker gutters. For
	/// narrow screens; with line numbers off it's "shared".
	gutterMarkers?: "shared" | "columns" | "overlay"
	/// Draw whitespace: dots for spaces, arrows for tabs, trailing space
	/// highlight, and a mark at line ends. Defaults to on when CodeMirror's
	/// `highlightWhitespace()` / `highlightTrailingWhitespace()` are in the
	/// state.
	showWhitespace?: boolean | {spaces?: boolean, trailing?: boolean, lineBreaks?: boolean}
	/// Fold markers, right of the line numbers in a narrow column (less
	/// than a character); tapping a line number toggles its fold. "fade" (the
	/// default) shows them for the fold range around the cursor, and
	/// for every foldable line while the mouse is over the gutter, like
	/// Ace's `fadeFoldWidgets` and VS Code's "mouseover". "always" shows
	/// every foldable line's marker, like CodeMirror's fold gutter.
	/// Folded lines always show theirs.
	foldMarkers?: "fade" | "always" | "none"
	/// Sticky scroll, like VS Code's: the header lines of the scopes
	/// around the top of the view (functions, classes, blocks: the
	/// syntax tree's fold ranges, or indentation for languages without
	/// them) stay pinned there while their bodies scroll. Tapping or
	/// clicking one scrolls to it. `maxLines` (default 5) caps how many
	/// show; at most a third of the visible height is used. Off by default.
	stickyScroll?: boolean | {maxLines?: number}
	/// VS Code-style indent guides (default true), drawn in the scene;
	/// `active` highlights the guide of the block around the cursor
	/// (default true); `hideOnBlankLines` skips blank lines.
	indentGuides?: boolean | {active?: boolean, hideOnBlankLines?: boolean}
	/// Indentation of wrapped continuation rows: "same" (default) as the
	/// line, "indent"/"deepIndent" one/two levels more, or "none".
	wrapIndent?: WrapIndent
	/// Soft-wrap long lines. Also enabled by CodeMirror's
	/// `EditorView.lineWrapping` extension.
	lineWrapping?: boolean
	/// Paragraph direction. Right-to-left text is always ordered by the
	/// Unicode bidi algorithm; this sets the direction lines start in.
	/// "ltr" (the default, like VS Code), "rtl" (every line
	/// right-to-left and right-aligned), or "auto": per line from its
	/// first strong character (Acode's "line based RTL switching", like
	/// CodeMirror's `perLineTextDirection`, which also selects it).
	textDirection?: TextDirectionMode
	tabSize?: number
	/// Room below the last line, as a fraction of the view height
	/// (`true` = 1: the last line can scroll to the top; Acode's 0.25 /
	/// 0.5 / 1 settings map directly). Default true.
	scrollPastEnd?: boolean | number
	/// Extra px to the right of the longest line when not wrapping, so
	/// line ends can scroll away from the edge (like Acode's
	/// `horizontalScrollPastEnd`), on top of 4 columns. Default 0.
	horizontalScrollPastEnd?: number
	/// Request a low-latency (desynchronized) canvas.
	lowLatency?: boolean
	/// Scroll speed: scales fling velocity and mouse wheel distance
	/// (dragging always follows the finger). A multiplier, or Acode's
	/// presets: "slow" (0.6), "normal" (1, Android's feel), "fast" (1.5),
	/// "fastX2" (2.2).
	scrollSpeed?: number | "slow" | "normal" | "fast" | "fastX2"
	/// Text input implementation. "auto" uses EditContext where
	/// available (Chrome/WebView 121+) and a hidden textarea otherwise.
	input?: "auto" | "editcontext" | "textarea"
	/// Cursor blink period in ms (0 disables blinking).
	cursorBlinkRate?: number
	/// Touch selection: handle size, timing, and the hooks for the
	/// consumer's selection menu and haptics.
	touchSelection?: TouchSelectionConfig
	/// Override how transactions are applied (like CodeMirror's
	/// `dispatchTransactions`).
	dispatchTransactions?: (trs: readonly Transaction[], view: CanvasView) => void
}

export interface FrameStat {
	/// rAF timestamp.
	time: number
	/// JS time spent producing the frame, in ms.
	work: number
	/// Whether the static scene was rebuilt this frame.
	rebuilt: boolean
	glyphs: number
	/// Visible lines without any syntax colors (only when a language is set).
	plainLines: number
	/// Visible lines colored from provisional or stale runs.
	approxLines: number
	/// Time split: scene rebuild, dynamic layers, atlas upload, GPU
	/// command submission (all ms).
	sceneMs: number
	dynMs: number
	atlasMs: number
	renderMs: number
	/// Part of `sceneMs`: measuring rows (wrapping) and updating plugins
	/// for a moved viewport.
	rowsMs: number
	viewportMs: number
	/// Atlas texels uploaded this frame.
	atlasTexels: number
	/// Input-to-submit latency for input handled this frame, or -1.
	latency: number
	scrollTop: number
}

type WhitespaceStyle = {color: PackedColor, trailing: PackedColor | null, spaces: boolean, lineBreaks: boolean}

const PAD_TOP = 4
/// Extra px a finger may land right of the gutter's marker area.
const TOUCH_SLOP = 10
/// The part of a line's height (top and bottom) where a touch in the
/// gutter may go to the neighboring line's fold or lint marker.
const TOUCH_EDGE = 0.35
const SCROLLBAR = 4
/// Far-reaching rects: clipped by the pass, independent of scroll.
const FAR = 1e6

// GPU context loss: how long to wait for a WebGL2 restore before
// replacing the canvas, the window for backing off repeated losses,
// and how many lost WebGPU devices make the view settle for WebGL2.
const RESTORE_TIMEOUT = 2000
const RECOVERY_WINDOW = 60000
const MAX_WEBGPU_LOSSES = 3

const defaultFont: FontSpec = {
	family: "ui-monospace, 'Roboto Mono', 'Droid Sans Mono', Menlo, Consolas, monospace",
	size: 14,
	// Until the CSS can be read (CodeMirror's base theme value).
	lineHeight: 1.4
}

/// A code editor view that draws with the GPU. It keeps CodeMirror's
/// `EditorState` as its model, so state-level extensions (history,
/// commands, language, autocomplete state, LSP client logic) work
/// unchanged, and it hosts CodeMirror's view plugins (tooltips,
/// panels, autocomplete, lint, search, decorations) through an
/// `EditorView`-compatible surface. The text drawing, scrolling and
/// input are its own.
export class CanvasView implements ScrollHost, InputHost {
	state: EditorState
	/// The outer element (CodeMirror's `.cm-editor`): panels and
	/// tooltips are placed in it.
	readonly dom: HTMLElement
	/// The drawing surface (`.cm-scroller`): canvas plus input element.
	readonly scrollDOM: HTMLElement
	/// The drawing canvas. Replaced by a fresh element when a GPU
	/// context is lost for good (a lost context can't be recreated on
	/// the same element).
	canvas: HTMLCanvasElement
	backend: RenderBackend | null = null
	metrics!: FontMetrics
	atlas!: GlyphAtlas
	theme: CanvasTheme
	dpr = 1
	width = 1
	height = 1
	stats: FrameStat[] = []
	recordStats = false

	private font: FontSpec
	/// The configured line height, or null to follow the CSS.
	private fixedLineHeight: number | null
	/// The line height couldn't be measured yet (not in the document).
	private lineHeightUnread = false
	/// The style modules and theme classes it was measured with.
	private lineHeightKey: unknown[] = []
	readonly layouts: LineLayouts
	/// Decorations from `EditorView.decorations` (marks, widgets, folds).
	readonly decos: DecoState
	/// Visual lines and rows (wrapping, folding, widgets).
	readonly lines: LineModel
	/// The hidden element receiving keyboard and IME input.
	readonly input: TextInput
	/// Touch selection (handles, gestures, menu hooks).
	readonly touchSelection: TouchSelection
	/// Block widgets' DOM, over reserved rows.
	private blocks: BlockLayer
	private plugins: PluginHost
	private focused = false
	private cursorOn = true
	/// Draw the cursor while blurred (a view that can't take focus).
	private steadyCursor = false
	private blinkTimer: ReturnType<typeof setTimeout> | null = null
	private composition: {from: number, to: number, thick: boolean}[] | null = null
	private syntax: SyntaxDriver
	private scroller: ScrollController
	private config: CanvasViewConfig
	private tabSize: number
	private lineNumbers: boolean
	private relativeNumbers = false
	private scrollPastEnd: number
	private wrapping = false
	private gutterHover = false
	/// Fold markers fade in and out ("fade" mode), like Acode's DOM fold
	/// gutter (`opacity .12s ease`): the hover set as a whole, and the
	/// marker of the fold range around the cursor per line. While one is
	/// fading, the dynamic layer is rebuilt every frame.
	private hoverFade = new Fade()
	private markerFades = new Map<number, Fade>()
	private foldFading = false
	private cursorFold: {key: unknown[], line: number} = {key: [], line: 0}
	private treeSyncTimer: ReturnType<typeof setTimeout> | null = null
	private treeSyncUrgent = false
	private syncedTree = -1
	private top = 0
	private left = 0
	private frameRequested = false
	private destroyed = false
	private pendingInput = -1
	/// When the user last typed or touched (performance.now()).
	private lastInput = -1e9

	/// Scrolling or typing recently: background work (parsing ahead)
	/// yields until the user pauses.
	private get interacting() { return this.scroller?.active || performance.now() - this.lastInput < 1000 }
	private lastFrameTop = 0
	private lastObservedScroll = {top: 0, left: 0}
	private maxCols = 0
	private resizeObserver: ResizeObserver
	private dprQuery: MediaQueryList | null = null
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	/// Viewport reported to plugins (rows), with margins so it changes
	/// once per screenful of scrolling, not every frame.
	private vp = {first: 0, last: -1}

	private scene: Scene
	// Selection, cursor, active line and gutter highlight, in scene
	// coordinates; rebuilt when the selection or visible window changes.
	// One buffer per layer, so every pass starts at instance 0.
	private underRects = new InstanceBuffer(RECT_STRIDE, 64)
	private overRects = new InstanceBuffer(RECT_STRIDE, 16)
	private cursorRects = new InstanceBuffer(RECT_STRIDE, 4)
	private handleGlyphs = new InstanceBuffer(GLYPH_STRIDE, 4)
	private gutterRects = new InstanceBuffer(RECT_STRIDE, 16)
	private dynGlyphs = new InstanceBuffer(GLYPH_STRIDE, 64)
	private placeholderGlyphs = new InstanceBuffer(GLYPH_STRIDE, 16)
	/// Sticky scroll lines, in screen coordinates, as two layers: the
	/// last line (moved by its pass offset while its scope's end pushes
	/// it up, so that costs no rebuild) and the ones above it. Rebuilt
	/// only when the lines shown or their content change.
	private stickyParts = [stickyPart(), stickyPart()]
	private scopes = new ScopeFinder()
	private sticky = {
		key: [] as unknown[],
		/// First lines of the visual lines shown, outermost first.
		lines: [] as number[],
		/// Their syntax runs (rebuilt when provisional ones change).
		runs: [] as (LineRuns | null)[],
		exact: true,
		/// Emitted column window (lines too long to emit whole).
		cols: {from: 0, to: 0},
		long: false,
		/// Offset of the last line (<= 0), and the bottom of the area.
		push: 0,
		height: 0
	}
	private blocksClip = 0
	// Scrollbar thumbs: rebuilt only when their size changes; their
	// position is the pass offset, so scrolling uploads nothing.
	private vThumb = new InstanceBuffer(RECT_STRIDE, 1)
	private hThumb = new InstanceBuffer(RECT_STRIDE, 1)
	private thumbs = {vSize: -1, hSize: -1, vY: 0, hX: 0, key: null as unknown}
	/// Rows the selection layers were built for.
	private selWindow = {first: 0, last: -1}
	private coverage = {plain: 0, approx: 0}
	/// Style table (font variant + tint); ids index into it.
	styles: TextStyle[] = []
	private classStyles: number[] = []
	private classDeco: TokenDeco[] = []
	/// The state's highlighters (null: the theme's `highlight` is used),
	/// and what their CSS depends on.
	private highlighters: readonly Highlighter[] | null = null
	private highlightKey: unknown[] = []
	private classReader!: ClassStyleReader
	/// Some class styles couldn't be read yet (not in the document).
	private stylesPending = false
	private variantStyles = new Map<number, number>()
	defaultStyle = 0
	gutterStyle = 0
	private gutterActiveStyle = 0

	constructor(config: CanvasViewConfig = {}) {
		this.config = config
		// Getting a WebGPU device takes a while (~80ms on a phone), in the
		// GPU process: start now, so it overlaps setting the view up.
		let device = config.backend == "webgpu" ? WebGPUBackend.requestDevice() : undefined
		// Its failure is reported where it's awaited, in initBackend.
		device?.catch(() => {})
		this.state = config.state ?? EditorState.create({doc: config.doc ?? "", extensions: config.extensions})
		this.font = {...defaultFont, ...config.font}
		this.fixedLineHeight = config.font?.lineHeight ?? null
		this.tabSize = config.tabSize ?? this.state.tabSize
		this.lineNumbers = (config.lineNumbers ?? true) !== false
		this.relativeNumbers = config.lineNumbers == "relative"
		let past = config.scrollPastEnd ?? true
		this.scrollPastEnd = past === true ? 1 : past === false ? 0 : Math.max(0, Math.min(1, past))
		this.theme = new CanvasTheme(config.theme ?? darkTheme)
		this.layouts = new LineLayouts(() => this.atlas, this.tabSize)
		this.decos = new DecoState(cls => this.theme.classStyle(cls), () => this.theme.dark)
		this.decos.onWidgetChange = ranges => this.widgetsChanged(ranges)
		let view = this
		this.lines = new LineModel({
			get doc() { return view.state.doc },
			layouts: this.layouts,
			decos: this.decos,
			widgetSpec: (w: WidgetType) => this.widgetSpec(w),
			blockRows: (point: PointDeco) => this.blocks.rows(point),
			noteWidth: (cells: number) => {
				if (cells > this.maxCols) {
					this.maxCols = Math.ceil(cells)
					this.requestFrame()
				}
			}
		})
		this.scene = new Scene(this)

		this.dom = document.createElement("div")
		this.dom.className = "cm-editor cv-editor"
		this.dom.style.background = cssColor(this.theme.background)
		this.scrollDOM = document.createElement("div")
		this.scrollDOM.className = "cm-scroller"
		Object.assign(this.scrollDOM.style, {
			position: "relative", overflow: "hidden", touchAction: "none", flex: "1 1 0", minHeight: "0",
			userSelect: "none", webkitUserSelect: "none", contain: "strict"
		} satisfies Partial<CSSStyleDeclaration>)
		this.dom.appendChild(this.scrollDOM)
		this.defineScrollProps()
		this.canvas = createCanvas()
		this.scrollDOM.appendChild(this.canvas)
		this.blocks = new BlockLayer({
			get lineHeight() { return view.lineHeight },
			blockResized: (point: PointDeco) => this.blockResized(point),
			isLive: (widget: WidgetType) => this.liveBlockWidgets().has(widget)
		}, this, this.scrollDOM)

		this.dpr = window.devicePixelRatio || 1
		this.classReader = new ClassStyleReader(this.scrollDOM)
		this.measure()
		this.highlighters = stateHighlighters(this.state)
		this.syntax = new SyntaxDriver(this.state, this.syntaxHighlighter, () => this.requestFrame())
		this.syntax.budget = () => this.scroller?.active ? 3 : 8
		this.syntax.scrolling = () => this.interacting
		this.scroller = new ScrollController(this)
		this.computeMaxCols()
		this.input = createInput(this, config.input)
		for (let el of [this.dom, this.scrollDOM, this.input.element]) domViews.set(el, this)
		this.touchSelection = new TouchSelection(this, config.touchSelection)
		this.plugins = new PluginHost(this)
		this.mouseHost = {
			get state() { return view.state },
			surface: this.scrollDOM,
			get lineHeight() { return view.lineHeight },
			get font() { return view.font },
			get dark() { return view.theme.dark },
			get scrollTop() { return view.scrollTop },
			set scrollTop(v) { view.scrollTop = v },
			get scrollLeft() { return view.scrollLeft },
			set scrollLeft(v) { view.scrollLeft = v },
			dispatch: this.dispatch,
			posAtClient: (x, y) => this.posAtClient(x, y),
			posAndSideAtClient: (x, y) => this.posAndSideAtClient(x, y),
			handleAnchor: (pos, side) => this.handleAnchor(pos, side),
			focus: () => this.focus(),
			holdFocus: hold => this.holdFocus(hold),
			runEventHandlers: (type, e) => this.runEventHandlers(type, e),
			setDropPos: pos => this.setDropPos(pos)
		}
		this.dragDrop = new TextDragDrop(this.mouseHost)

		this.resizeObserver = new ResizeObserver(() => this.onResize())
		this.resizeObserver.observe(this.scrollDOM)
		window.visualViewport?.addEventListener("resize", this.onViewportChange)
		window.visualViewport?.addEventListener("scroll", this.onViewportChange)
		this.watchDPR()
		document.fonts?.addEventListener?.("loadingdone", this.onFontsLoaded)
		// Taps, clicks and gutter presses act on the full syntax tree.
		this.scrollDOM.addEventListener("pointerdown", this.onPointerDownFirst, true)
		this.scrollDOM.addEventListener("pointerdown", this.onMouseDown)
		// Taps generate compatibility mouse events afterwards; their
		// default action would move focus off the input element.
		this.scrollDOM.addEventListener("mousedown", this.preventFocusLoss)
		// Long presses are handled here; no native context menu.
		this.scrollDOM.addEventListener("contextmenu", this.preventContextMenu)
		this.scrollDOM.addEventListener("pointermove", this.onPointerHover)
		this.scrollDOM.addEventListener("pointerleave", this.onPointerHover)

		if (config.parent) config.parent.appendChild(this.dom)
		let rect = this.scrollDOM.getBoundingClientRect()
		this.width = Math.max(1, rect.width)
		this.height = Math.max(1, rect.height)
		this.plugins.init()
		this.highlightKey = this.highlightStyleKey()
		this.syncLineHeight()
		this.syncWritable()
		this.decos.reset(this as any, this.state.doc)
		this.lines.invalidate([0, this.state.doc.length])
		this.syncWrapping()
		this.initBackend(config.backend ?? "auto", device)
	}

	private async initBackend(kind: "auto" | BackendKind, device?: Promise<GPUDevice | null>) {
		let backend: RenderBackend | null = null
		// Size the canvas before it has a context: resizing it after
		// reallocates the drawing buffer the context just made (~20ms on
		// a phone, for nothing).
		let size = () => {
			this.canvas.width = deviceSize(this.width, this.dpr)
			this.canvas.height = deviceSize(this.height, this.dpr)
		}
		// A device that keeps getting lost is worse than WebGL2.
		if (kind == "webgpu" && this.webgpuLosses < MAX_WEBGPU_LOSSES) {
			size()
			try { backend = await WebGPUBackend.create(this.canvas, device) }
			catch (e) {
				console.warn("canvas-view: WebGPU init failed, using WebGL2", e)
				// The canvas may hold a WebGPU context now, and then can't
				// give a WebGL2 one.
				this.replaceCanvas()
			}
		}
		if (this.destroyed) { backend?.destroy(); return }
		if (!backend) {
			// After a failed WebGPU start this is a new canvas.
			size()
			backend = new WebGL2Backend(this.canvas, {lowLatency: this.config.lowLatency})
		}
		let current = backend
		backend.onLost = permanent => this.onContextLost(current, permanent)
		backend.onRestored = () => this.onContextRestored(current)
		this.backend = backend
		if (this.atlas.maxSize > backend.maxTextureSize) this.measure()
		this.onResize()
		// Lost before the callbacks were attached (or created lost).
		if (backend.lost) this.onContextLost(backend, backend.kind == "webgpu")
	}

	// ---- GPU context loss ------------------------------------------------------

	private recoveryTimer: ReturnType<typeof setTimeout> | null = null
	/// Times of recent backend replacements, for backing off.
	private recoveries: number[] = []
	private webgpuLosses = 0
	/// Number of times the backend was replaced after a context loss.
	contextRecoveries = 0

	/// A WebGL2 context may be restored by the browser (after a GPU
	/// process restart, `webglcontextrestored`): wait for that a little,
	/// then replace the canvas. Contexts evicted for exceeding the
	/// browser's limit, and lost WebGPU devices, never come back.
	private onContextLost(backend: RenderBackend, permanent: boolean) {
		if (backend != this.backend || this.destroyed) return
		this.scheduleRecovery(permanent ? 0 : RESTORE_TIMEOUT)
	}

	private onContextRestored(backend: RenderBackend) {
		if (backend != this.backend || this.destroyed) return
		if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
		this.recoveryTimer = null
		// The backend re-uploads everything on its next render.
		this.requestFrame()
	}

	private scheduleRecovery(delay: number) {
		let now = performance.now()
		this.recoveries = this.recoveries.filter(t => now - t < RECOVERY_WINDOW)
		// Back off when contexts keep getting lost (e.g. more views than
		// the browser allows contexts, which would evict each other in
		// a loop).
		let n = this.recoveries.length
		if (n) delay = Math.max(delay, Math.min(RECOVERY_WINDOW, 1000 * 4 ** (n - 1)))
		if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
		this.recoveryTimer = setTimeout(this.recoverBackend, delay)
	}

	private recoverBackend = () => {
		this.recoveryTimer = null
		let old = this.backend
		if (this.destroyed || !old || !old.lost) return
		this.recoveries.push(performance.now())
		this.contextRecoveries++
		if (old.kind == "webgpu") this.webgpuLosses++
		old.onLost = old.onRestored = null
		old.destroy()
		this.backend = null
		this.replaceCanvas()
		// The new backend has no GPU objects: its first frame uploads the
		// whole atlas and every instance buffer.
		this.initBackend(old.kind)
	}

	private replaceCanvas() {
		let next = createCanvas()
		this.canvas.replaceWith(next)
		this.canvas = next
	}

	/// CodeMirror code reads and sets `scrollDOM.scrollTop`; route that
	/// to the view's own scroll position.
	/// `scrollDOM`'s scroll properties drive the view. Writes come from
	/// outside (an app's scrollbar, restoring a position) and stop a fling
	/// in progress, which would otherwise keep moving from where it was.
	private defineScrollProps() {
		let view = this
		let external = () => view.scroller?.cancelFling()
		Object.defineProperties(this.scrollDOM, {
			scrollTop: {get() { return view.scrollTop }, set(v: number) { external(); view.scrollTop = v }, configurable: true},
			scrollLeft: {get() { return view.scrollLeft }, set(v: number) { external(); view.scrollLeft = v }, configurable: true},
			scrollHeight: {get() { return view.scrollHeightPx }, configurable: true},
			scrollWidth: {get() { return view.width + view.maxScrollLeft }, configurable: true},
			scrollTo: {value(a: number | {top?: number, left?: number}, b?: number) {
				external()
				if (typeof a == "number") { view.scrollLeft = a; view.scrollTop = b ?? view.scrollTop }
				else { if (a.top != null) view.scrollTop = a.top; if (a.left != null) view.scrollLeft = a.left }
			}, configurable: true},
			scrollBy: {value(a: number | {top?: number, left?: number}, b?: number) {
				external()
				if (typeof a == "number") { view.scrollLeft += a; view.scrollTop += b ?? 0 }
				else { view.scrollTop += a.top ?? 0; view.scrollLeft += a.left ?? 0 }
			}, configurable: true}
		})
	}

	/// The element events and coordinates are relative to.
	get surface() { return this.scrollDOM }

	// ---- Geometry -------------------------------------------------------

	get lineHeight() { return this.metrics.lineHeight }
	get cellWidth() { return this.metrics.cellWidth }

	/// The gutter is kept as narrow as possible for small screens: the
	/// digits of the last line number, half a cell of padding on the
	/// left, and on the right half a cell, or a slightly wider column for
	/// fold markers when they're enabled.
	get gutterWidth() {
		let left = this.gutterLeft
		if (!this.lineNumbers) return left ? left + 2 : 0
		let digits = String(this.state.doc.lines).length
		// With a marker column, it provides the left padding.
		return left + Math.ceil((digits + (left ? 0.15 : 0.5)) * this.metrics.cellWidth + this.gutterPad)
	}

	private gutters = new Gutters()

	/// Extra gutter columns (CodeMirror `gutter()` configs: lint,
	/// breakpoints...), left of the line numbers.
	private get gutterColumns() { return this.gutters.columns(this.state) }

	private get gutterColumnWidth() {
		return Math.round(Math.max(this.metrics.cellWidth * 1.1, this.metrics.lineHeight * 0.55))
	}

	/// How many marker columns are drawn.
	private get markerColumnCount() {
		let n = this.gutterColumns.length
		if (this.overlayMarkers) return 0
		return (this.config.gutterMarkers ?? "shared") == "columns" ? n : Math.min(1, n)
	}

	/// Markers are drawn over the line numbers' padding (no column).
	private get overlayMarkers() { return this.config.gutterMarkers == "overlay" && !!this.lineNumbers }

	/// x (CSS px) where line `n`'s number starts.
	private numberLeft(n: number) {
		let {line} = this.gutterRow(n), shown = line
		if (this.relativeNumbers) {
			let cur = this.state.doc.lineAt(this.state.selection.main.head).number
			if (line != cur) shown = Math.abs(line - cur)
		}
		return this.gutterRight - String(shown).length * this.cellWidth
	}

	/// Where an overlaid marker goes on line `n`: the space left of its
	/// number, or the gutter's left edge when there's too little.
	private overlayBox(n: number) {
		let w = this.gutterColumnWidth, free = this.numberLeft(n) - 1
		return free >= w ? {x: free - w, w} : {x: 0, w: Math.max(0, free)}
	}

	/// Whether x (CSS px) on line `n` is on its overlaid marker's area.
	private onOverlayMarker(x: number, n: number) {
		return this.overlayMarkers && this.gutterColumns.length > 0 && x < Math.max(this.numberLeft(n), 10)
	}

	/// The gutter configs drawn in marker column `col` (all of them in
	/// the shared column or overlaid).
	private columnConfigs(col: number) {
		let all = this.gutterColumns
		return this.markerColumnCount == all.length ? all.slice(col, col + 1) : all
	}

	/// Width of extra gutter columns left of the line numbers.
	get gutterLeft() { return this.markerColumnCount * this.gutterColumnWidth }

	/// Space right of the line numbers (holds fold markers).
	private get gutterPad() {
		let cw = this.metrics.cellWidth
		return (this.config.foldMarkers ?? "fade") == "none" ? cw / 2 : Math.max(10, Math.round(cw * 1.25))
	}

	get contentLeft() { return this.gutterWidth + Math.round(this.metrics.cellWidth * (this.gutterWidth ? 0.4 : 0.5)) }

	/// Top of row 0 in content coordinates: the padding, then block
	/// widgets placed before line 1.
	get rowsTop() { return PAD_TOP + this.lines.headRows * this.lineHeight }

	/// Top of a 0-based row in content coordinates.
	rowTop(row: number) { return this.rowsTop + row * this.lineHeight }

	/// Scrollable height (rows plus padding and scroll-past-end room).
	get scrollHeightPx() {
		let rows = this.lines.totalRows * this.lineHeight + this.rowsTop
		let past = Math.round(Math.max(0, this.height - this.lineHeight - PAD_TOP) * this.scrollPastEnd)
		return rows + Math.max(PAD_TOP, past)
	}

	/// Extra scroll room so the last lines can be scrolled above an
	/// on-screen keyboard that overlays the editor.
	get maxScrollTop() { return Math.max(0, this.scrollHeightPx + this.bottomInset - this.height) }

	/// The part of the view's height not covered by an on-screen keyboard.
	get visibleHeight() { return Math.max(this.lineHeight * 2, this.height - this.bottomInset) }

	/// How much of the editor's bottom the on-screen keyboard covers (CSS px).
	bottomInset = 0

	get maxScrollLeft() {
		if (this.wrapping) return 0
		// Like VS Code's `scrollBeyondLastColumn: 4`, clear of the scrollbar.
		let extra = Math.max(0, this.config.horizontalScrollPastEnd ?? 0) + SCROLLBAR + 4
		return Math.max(0, (this.maxCols + 4) * this.cellWidth + extra - (this.width - this.contentLeft))
	}

	get scrollTop() { return this.top }
	set scrollTop(v: number) {
		let next = Math.max(0, Math.min(this.maxScrollTop, v))
		if (next != this.top) {
			this.top = next
			this.requestFrame()
		}
	}

	get scrollLeft() { return this.left }
	set scrollLeft(v: number) {
		let next = Math.max(0, Math.min(this.maxScrollLeft, v))
		if (next != this.left) {
			this.left = next
			this.requestFrame()
		}
	}

	/// Top of line `n`'s visual line in content coordinates.
	lineTop(n: number) { return this.rowTop(this.lines.rowOf(n)) }

	/// 0-based row at a content y.
	rowAtHeight(y: number) {
		return Math.max(0, Math.min(this.lines.totalRows - 1, Math.floor((y - this.rowsTop) / this.lineHeight)))
	}

	/// First document line of the visual line at a content y.
	lineAtHeight(y: number) { return this.lines.lineAtRow(this.rowAtHeight(y)).line }

	/// Global row and x (cells from the row start) of a position. `side`
	/// (a cursor's `assoc`) < 0 binds to the end of a wrapped row.
	posCoords(pos: number, side = 1) {
		let vl = this.lines.vline(this.state.doc.lineAt(pos).number)
		let c = this.lines.coordsIn(vl, pos - vl.from, side)
		return {row: this.lines.rowOf(vl.first) + c.row, x: c.x, vl}
	}

	/// Position at a global row and x (cells), and the side it binds to.
	posAtRow(row: number, x: number) {
		let lines = this.lines
		let {line, rowStart} = lines.lineAtRow(row)
		let vl = lines.vline(line)
		let r = Math.max(0, Math.min(vl.rows - 1, row - rowStart))
		let res = lines.posInRow(vl, r, x)
		return {pos: vl.from + res.pos, side: res.side}
	}

	private surfaceRect() { return this.scrollDOM.getBoundingClientRect() }

	/// Screen coordinates (relative to the viewport) for a position.
	coordsAtPos(pos: number, side = 1) {
		let {row, x} = this.posCoords(pos, side)
		let rect = this.surfaceRect()
		let left = rect.left + this.contentLeft + x * this.cellWidth - this.left
		let top = rect.top + this.rowTop(row) - this.top
		return {left, right: left, top, bottom: top + this.lineHeight}
	}

	/// Document position at client coordinates. Accepts CodeMirror's
	/// `({x, y}, precise)` form too.
	posAtCoords(coords: {x: number, y: number} | number, yOrPrecise?: number | boolean): number {
		if (typeof coords == "number") return this.posAtClient(coords, yOrPrecise as number)
		return this.posAtClient(coords.x, coords.y)
	}

	posAtClient(clientX: number, clientY: number) {
		return this.posAndSideAtClient(clientX, clientY).pos
	}

	/// Position at client coordinates and the side (cursor `assoc`) a
	/// cursor placed there should have: -1 at the end of a wrapped row.
	posAndSideAtClient(clientX: number, clientY: number) {
		let rect = this.surfaceRect()
		let y = clientY - rect.top + this.top, x = clientX - rect.left - this.contentLeft + this.left
		return this.posAtRow(this.rowAtHeight(y), x / this.cellWidth)
	}

	/// CodeMirror's `posAndSideAtCoords`.
	posAndSideAtCoords(coords: {x: number, y: number}, _precise?: boolean) {
		let {pos, side} = this.posAndSideAtClient(coords.x, coords.y)
		return {pos, assoc: side}
	}

	// ---- State ------------------------------------------------------------

	/// Apply transactions (bound, since CodeMirror commands destructure
	/// `dispatch` from the view).
	dispatch = (...specs: (Transaction | TransactionSpec)[]) => {
		let tr = specs.length == 1 && specs[0] instanceof Transaction
			? specs[0] : this.state.update(...specs as TransactionSpec[])
		// Pointer selections (taps, clicks, drags, handles) don't stop
		// inside atomic ranges, as in CodeMirror's mouse selection.
		if (tr.selection && !tr.docChanged && tr.isUserEvent("select.pointer") && !(specs[0] instanceof Transaction)) {
			let atoms = this.atoms()
			let sel = atoms.length ? skipAtomsForSelection(atoms, tr.selection) : tr.selection
			if (sel != tr.selection) tr = this.state.update(...specs as TransactionSpec[], {selection: sel})
		}
		if (this.config.dispatchTransactions) this.config.dispatchTransactions([tr], this)
		else this.update([tr])
	}

	update(trs: readonly Transaction[]) { this.applyUpdate(trs, 0) }

	/// Apply transactions and/or view changes (`flags` as in ViewUpdate:
	/// 1 focus, 4|8 viewport, 16 geometry), then update plugins and
	/// decorations.
	private applyUpdate(trs: readonly Transaction[], flags: number) {
		if (this.plugins.isUpdating) throw new Error("Calls to EditorView.update are not allowed while an update is in progress")
		let startState = this.state
		let finalState = trs.length ? trs[trs.length - 1].state : this.state
		let vu = this.plugins.makeUpdate(finalState, trs, flags)
		let selectionChanged = false, scrollTargets: unknown[] = [], reconfigured = false
		for (let tr of trs) {
			if (tr.startState != this.state) throw new RangeError("canvas-view: transaction doesn't start from the current state")
			this.state = tr.state
			this.syntax.update(tr.state, tr.docChanged ? tr.changes : null)
			if (tr.docChanged) {
				this.lines.mapChanges(tr.changes, tr.startState.doc, tr.state.doc)
				this.scene.mapChanges(tr.changes, tr.state.doc)
				tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
					let doc = tr.state.doc
					for (let n = doc.lineAt(fromB).number, end = doc.lineAt(toB).number; n <= end; n++)
						this.maxCols = Math.max(this.maxCols, this.layouts.width(doc.line(n).text))
				})
			}
			if (tr.reconfigured) reconfigured = true
			if (tr.selection) selectionChanged = true
			if (tr.scrollIntoView) scrollTargets.push(tr.state.selection.main.head)
			for (let e of tr.effects) if (e.is(scrollIntoViewType)) scrollTargets.push(e.value)
		}
		this.plugins.update(vu)
		if (reconfigured) {
			this.syncLineHeight()
			this.syncHighlighting()
			this.syncWrapping()
			this.syncTabSize()
			this.syncWritable()
		}
		this.refreshDecorations(vu.docChanged ? vu.changes : null)
		if (vu.docChanged) {
			this.invalidateBlankNeighbors(vu.changes)
			let rainbow = this.rainbowState, pub = rainbow && this.syntax.canonicalTree(this.state.doc)
			rainbow?.mapEdit(vu.changes, startState.doc, this.state.doc, pub?.tree ?? null, pub?.len ?? 0)
		}
		for (let target of scrollTargets) {
			if (typeof target == "number") this.scrollPosIntoView(target)
			else this.applyScrollTarget(target as any)
		}
		if (trs.length) {
			this.input.update(trs, startState)
			this.touchSelection.onUpdate(trs)
		}
		this.mouseSelection?.update(vu)
		if (vu.docChanged && this.dropPos != null) this.dropPos = vu.changes.mapPos(this.dropPos)
		this.syncContentAttributes()
		if (selectionChanged || vu.docChanged) this.restartBlink()
		this.requestFrame()
	}

	/// Read the decoration facet and invalidate what changed.
	private refreshDecorations(changes: ChangeDesc | null) {
		let res = this.decos.update(this as any, this.state.doc, changes)
		if (!res) return
		if (res.points.length) {
			// Widgets appearing above the top line mustn't move the text in view.
			let anchor = this.lines.lineAtRow(this.rowAtHeight(this.top))
			let offset = this.top - this.rowTop(anchor.rowStart)
			this.lines.invalidate(res.points)
			if (!this.lines.identity && !changes) this.keepAnchor(anchor.line, offset)
		}
		if (res.marks.length) this.scene.invalidate(res.marks)
		if (res.points.length) this.scene.invalidate(res.points)
		this.dynKey = []
		this.sticky.key = []
	}

	/// The tab size follows the state's `EditorState.tabSize` unless the
	/// config sets one.
	private syncTabSize() {
		let size = this.config.tabSize ?? this.state.tabSize
		if (size == this.tabSize) return
		this.tabSize = this.layouts.tabSize = size
		this.layouts.clear()
		this.lines.reset()
		this.computeMaxCols()
		this.requestFrame()
	}

	/// Line wrapping follows the config and `EditorView.lineWrapping`.
	private syncWrapping() {
		let wrap = this.config.lineWrapping ?? wantsLineWrapping(this.state, this)
		this.wrapping = wrap
		let cols = wrap ? Math.max(8, Math.floor((this.width - this.contentLeft - this.cellWidth * 0.5) / this.cellWidth)) : 0
		if (this.lines.setWrap(cols, this.config.wrapIndent ?? "same")) {
			this.scrollLeft = 0
			this.requestFrame()
		}
		// Right-to-left rows align to the text area's right edge.
		let dir = this.config.textDirection ?? (this.state.facet(EditorView.perLineTextDirection) ? "auto" : "ltr")
		let area = Math.max(8, Math.floor((this.width - this.contentLeft - this.cellWidth * 0.5) / this.cellWidth))
		if (this.lines.setDirection(dir, area)) this.requestFrame()
	}

	/// Handle CodeMirror `EditorView.scrollIntoView` effects.
	private applyScrollTarget(target: {range: SelectionRange, y: string, yMargin: number, x: string, xMargin: number}) {
		this.measureAround(target.range.head)
		let {row} = this.posCoords(target.range.head)
		let top = this.rowTop(row), lh = this.lineHeight
		if (target.y == "start") this.scrollTop = top - target.yMargin
		else if (target.y == "end") this.scrollTop = top + lh + target.yMargin - this.visibleHeight
		else if (target.y == "center") this.scrollTop = top + lh / 2 - this.visibleHeight / 2
		else this.scrollPosIntoView(target.range.head, Math.max(lh, target.yMargin))
	}

	setState(state: EditorState) {
		// Keep the measured rows of the document being left: when it's
		// shown again (switching tabs), scroll positions saved in pixels
		// then land on the same lines on the first frame.
		let rows = this.lines.saveRows()
		if (rows) this.savedRows.set(this.state.doc, {rows, key: this.rowsKey()})
		this.plugins.destroy()
		this.touchSelection.reset()
		this.mouseSelection = null
		this.dropPos = null
		this.composition = null
		this.state = state
		this.input.setState(state)
		this.syntax.destroy()
		let prevHighlighters = this.highlighters
		this.highlighters = stateHighlighters(state)
		this.syntax = new SyntaxDriver(state, this.syntaxHighlighter, () => this.requestFrame())
		this.syntax.budget = () => this.scroller.active ? 3 : 8
		this.syntax.scrolling = () => this.interacting
		this.computeMaxCols()
		// Plugins read the viewport while they're created: lay out the new
		// document first (without decorations, which come from the plugins),
		// with the viewport and scroll position moved into it.
		this.decos.clear()
		this.lines.reset()
		this.syncWrapping()
		this.vp.first = 0
		this.vp.last = -1
		this.scrollTop = this.top
		this.scrollLeft = this.left
		this.plugins = new PluginHost(this)
		this.plugins.init()
		this.syncLineHeight()
		this.syncWritable()
		this.markerFades.clear()
		let key = this.highlightStyleKey()
		if (!sameHighlighters(prevHighlighters, this.highlighters) || !sameKey(key, this.highlightKey)) {
			this.highlightKey = key
			this.resetStyles()
		}
		this.decos.reset(this as any, state.doc)
		this.lines.reset()
		this.lines.invalidate([0, state.doc.length])
		this.syncWrapping()
		let saved = this.savedRows.get(state.doc)
		if (saved && sameKey(saved.key, this.rowsKey())) this.lines.restoreRows(saved.rows)
		this.scene.reset(this.scene.origin)
		this.dynKey = []
		this.requestFrame()
	}

	private savedRows = new WeakMap<EditorState["doc"], {rows: RowMap, key: unknown[]}>()

	/// What saved rows depend on besides the document.
	private rowsKey(): unknown[] {
		let l = this.lines
		return [l.wrap, l.wrapIndent, l.direction, l.alignCols, this.tabSize, this.metrics]
	}

	/// Make sure the rows around a position are measured (wrapping).
	private measureAround(pos: number) {
		if (this.lines.identity) return
		let n = this.state.doc.lineAt(pos).number
		this.lines.measure(n - 50, n + 50, n)
	}

	scrollPosIntoView(pos: number, margin = this.lineHeight) {
		this.measureAround(pos)
		let {row, x} = this.posCoords(pos)
		// Sticky lines cover the top: keep the line below them.
		let y = this.rowTop(row), above = margin + this.stickyInset(pos)
		if (y - above < this.top) this.scrollTop = y - above
		else if (y + this.lineHeight + margin > this.top + this.visibleHeight) this.scrollTop = y + this.lineHeight + margin - this.visibleHeight
		let px = x * this.cellWidth
		let room = this.width - this.contentLeft
		if (px - this.cellWidth * 4 < this.left) this.scrollLeft = px - this.cellWidth * 4
		else if (px + this.cellWidth * 4 > this.left + room) this.scrollLeft = px + this.cellWidth * 4 - room
	}

	// ---- Input hooks --------------------------------------------------------

	// Gestures: taps, long presses and handle drags go to touch selection
	// (which focuses inside the gesture so mobile keyboards open), after
	// fold toggles and widget clicks.
	onTap(x: number, y: number, e: PointerEvent) {
		if (this.blocks.contains(e.target)) return
		if (this.stickyClick(x, y, e)) return
		if (this.clickSpecial(x, y, e)) {
			// Like CodeMirror, where the gutter isn't focusable, a finger on
			// it takes focus from the editor. Otherwise Android shows the
			// keyboard again (after the user hid it) on any touch while the
			// input is focused (checked on a device: cancelling the touch
			// events doesn't prevent it).
			if (x - this.surfaceRect().left < this.gutterWidth && this.hasFocus) this.input.element.blur()
			return
		}
		this.touchSelection.onTap(x, y, e)
	}
	claimTouch(x: number, y: number) { return this.touchSelection.claimTouch(x, y) }
	// The text under sticky lines isn't what the finger is on.
	onLongPress(x: number, y: number) { return !this.stickyAt(x, y) && this.touchSelection.onLongPress(x, y) }
	gestureMove(x: number, y: number) { this.touchSelection.gestureMove(x, y) }
	gestureEnd(x: number, y: number, cancelled = false) { this.touchSelection.gestureEnd(x, y, cancelled) }
	foreignTarget(target: EventTarget | null) { return this.blocks.contains(target) }

	onScrollStart() {
		this.clearMarkerProxy()
		this.touchSelection.onScrollStart()
	}
	onScrollEnd() { this.touchSelection.onScrollEnd() }

	/// Gutter taps toggle folds; taps on fold placeholders unfold; taps
	/// on other widgets are forwarded to their DOM as clicks.
	private clickSpecial(clientX: number, clientY: number, e: Event) {
		let rect = this.surfaceRect()
		let x = clientX - rect.left, y = clientY - rect.top + this.top
		let row = this.rowAtHeight(y)
		if (y > this.rowTop(this.lines.totalRows)) return false
		if (x < this.gutterWidth) {
			// Gutter targets are a line tall and narrow: fingers get some
			// slop (TOUCH_SLOP px past the marker column; a tap near a line
			// edge that has nothing to act on goes to the neighbor's fold
			// or lint marker). The mouse is exact.
			let touch = e instanceof PointerEvent && e.pointerType != "mouse", slop = touch ? TOUCH_SLOP : 0
			let line = this.lines.lineAtRow(row).line, overlay = this.overlayMarkers
			if (this.gutterColumns.length && (overlay || this.gutterLeft > 0)) {
				// Overlaid, the area grows to a minimum width, never over the number.
				let edge = overlay ? Math.max(this.numberLeft(line), 10 + slop) : this.gutterLeft + slop
				if (x < edge) {
					let col = overlay ? 0 : Math.min(this.markerColumnCount - 1, Math.floor(x / this.gutterColumnWidth))
					if (touch) line = this.touchSnap(y, row, line, n => {
						let m = this.markerAt(col, n)
						return m != null && this.gutterHasHover(m.config)
					}, n => this.markerAt(col, n) != null)
					return this.gutterColumnClick(col, line, e)
				}
			}
			if (this.lineNumbers) {
				if (this.config.onLineNumberClick?.(line, e, this)) { e.preventDefault(); return true }
				if (touch) line = this.touchSnap(y, row, line, n => this.canFold(n), n => this.canFold(n))
				// Like CodeMirror, the gutter isn't text: a tap on a number
				// with nothing to fold doesn't move the cursor or focus (which
				// would open the on-screen keyboard).
				this.toggleFold(line)
				return true
			}
		}
		let {line, rowStart} = this.lines.lineAtRow(row)
		let vl = this.lines.vline(line)
		if (!vl.pieces) return false
		let r = Math.min(vl.rows - 1, row - rowStart)
		let col = this.lines.colAtX(vl, r, (x - this.contentLeft + this.left) / this.cellWidth).col
		for (let p of vl.pieces) {
			if (p.kind == PieceKind.Text || !p.cells || col < p.col || col >= p.col + p.cells) continue
			let from = vl.from + p.from, to = vl.from + p.to
			if (p.kind == PieceKind.Replace) {
				let folded = false
				foldedRanges(this.state).between(from, to, (a, b) => { if (a == from && b == to) folded = true })
				if (folded) {
					this.dispatch({effects: unfoldEffect.of({from, to})})
					return true
				}
			}
			let widget = p.point?.deco.spec.widget as WidgetType | undefined
			let dom = widget ? this.decos.widgetElement(widget, this as any) : null
			if (dom) {
				// The widget's DOM gets the events, then CodeMirror event
				// handlers (with the widget element as target). Unless one
				// of them handles it, the press also places the cursor (on
				// the widget's nearer side): widgets are small targets.
				let init = {bubbles: true, cancelable: true, clientX, clientY}, handled = false
				for (let type of ["mousedown", "click"]) {
					let ev = new MouseEvent(type, init)
					dom.dispatchEvent(ev)
					if (this.plugins.handle(type, ev) || ev.defaultPrevented) handled = true
				}
				if (handled) e.preventDefault()
				return handled
			}
		}
		return false
	}

	/// A block widget's height changed: re-measure its rows, keeping the
	/// top line in place.
	private blockResized(point: PointDeco) {
		let anchor = this.lines.lineAtRow(this.rowAtHeight(this.top))
		let offset = this.top - this.rowTop(anchor.rowStart)
		this.lines.invalidate([Math.max(0, point.from - 1), point.to + 1])
		this.keepAnchor(anchor.line, offset)
		this.requestFrame()
	}

	/// Position the visible block widgets (DOM over their rows).
	/// Created on first use (most views never drag a handle).
	private magnifier: Magnifier | null = null

	/// The touch selection magnifier copies from the frame just drawn:
	/// a GPU canvas can be read only in the task that drew it.
	private placeMagnifier() {
		let at = this.touchSelection.magnifierPoint
		if (!at) {
			this.magnifier?.hide()
			return
		}
		let config = this.config.touchSelection?.magnifier
		this.magnifier ??= new Magnifier(this.scrollDOM, typeof config == "object" ? config : {})
		this.magnifier.show(this.canvas, at.x, at.y, {width: this.width, height: this.height, lineHeight: this.lineHeight, fontSize: this.font.size})
	}

	private placeBlocks() {
		if (!this.decos.blockCount && !this.blocks.size) return
		let blocks = this.blocks, lines = this.lines, lh = this.lineHeight
		blocks.begin()
		if (this.decos.blockCount) {
			let {firstRow, lastRow} = this.visibleRows()
			// Like CodeMirror: block widgets span the content (from the
			// gutter's edge, as wide as the longest line or the view) and
			// scroll with the text, under the gutter (the layer starts at it).
			blocks.setLeft(this.gutterWidth)
			let x = -this.left, width = this.width - this.gutterWidth + this.maxScrollLeft
			let head = lines.headBlocks
			if (head && this.top < this.rowsTop) {
				let y = PAD_TOP
				for (let b of head) {
					blocks.place(b.point, x, y - this.top, width)
					y += b.rows * lh
				}
			}
			for (let n = lines.lineAtRow(firstRow).line, end = lines.lineAtRow(lastRow).line; n <= end && n <= this.state.doc.lines;) {
				let vl = lines.vline(n)
				if (vl.cover && vl.rows) blocks.place(vl.cover, x, this.rowTop(lines.rowOf(vl.first)) - this.top, width)
				if (vl.inner) for (let b of vl.inner)
					if (b.rows) blocks.place(b.point, x, this.rowTop(lines.rowOf(vl.first) + b.row) - this.top, width)
				if (vl.blocks) {
					let row = lines.rowOf(vl.first) + vl.rows
					for (let b of vl.blocks) {
						blocks.place(b.point, x, this.rowTop(row) - this.top, width)
						row += b.rows
					}
				}
				n = vl.last + 1
			}
		}
		blocks.end()
	}

	private liveBlocks: {points: unknown, set: Set<WidgetType>} = {points: null, set: new Set()}

	/// The row where visual line `n`'s number and gutter markers go, and
	/// the number: its first text row (after a block replace at its start,
	/// like CodeMirror).
	private gutterRow(n: number): {row: number, line: number} {
		let row = this.lines.rowOf(n)
		if (!this.decos.coverCount) return {row, line: n}
		let t = this.lines.textRow(this.lines.vline(n))
		return {row: row + t.row, line: t.line}
	}

	/// Block widgets in the current decorations (cached per point list).
	private liveBlockWidgets() {
		let live = this.liveBlocks, points = this.decos.points
		if (live.points !== points) {
			live.points = points
			live.set = new Set()
			for (let p of points) if (p.block || p.blockReplace && p.deco.spec.widget) live.set.add(p.deco.spec.widget as WidgetType)
		}
		return live.set
	}

	/// Inline widgets' DOM changed in place (CodeMirror widget DOM is
	/// live): lay out and draw their lines again.
	private widgetsChanged(ranges: number[]) {
		let anchor = this.lines.lineAtRow(this.rowAtHeight(this.top))
		let offset = this.top - this.rowTop(anchor.rowStart)
		this.lines.invalidate(ranges)
		if (!this.lines.identity) this.keepAnchor(anchor.line, offset)
		this.scene.invalidate(ranges)
		this.dynKey = []
		this.requestFrame()
	}

	/// A tap/click in an extra gutter column: the gutter's own
	/// `domEventHandlers` first, then the markers there get the event
	/// (lint markers open their tooltip).
	private gutterColumnClick(col: number, n: number, e: Event) {
		let configs = this.columnConfigs(col)
		if (!configs.length) return false
		let block = this.lineBlockAt(this.state.doc.line(n).from)
		// The gutter whose marker is drawn here first, then the others.
		let shown = this.markerAt(col, n)
		let order = shown ? [shown.config, ...configs.filter(c => c != shown!.config)] : configs
		if (!shown || !shown.look.dom || !this.gutterHasHover(shown.config)) {
			for (let config of order) for (let type of ["mousedown", "click"]) {
				let h = config.domEventHandlers?.[type]
				if (h && h(this, block, e)) { e.preventDefault(); return true }
			}
		}
		this.activateMarker(col, n, "mouseover")
		// Gutter taps never move the cursor.
		return true
	}

	private markerProxy: HTMLElement | null = null
	private markerProxyAt = ""
	/// The proxy's line and drawn top (px from the view's top).
	private markerProxyLine = 0
	private markerProxyTop = 0

	/// Give a marker's DOM element a place on screen (invisible, over the
	/// drawn marker) so CodeMirror code that measures it works, and send
	/// it an event.
	/// The marker drawn in column `col` on line `n` (first gutter wins).
	private markerAt(col: number, n: number) {
		let line = this.state.doc.line(n)
		for (let config of this.columnConfigs(col)) {
			let found: GutterMarker | null = null
			for (let set of this.gutters.markerSets(config, this)) set.between(line.from, line.from, (from, _to, marker) => {
				if (!found && from == line.from) found = marker
			})
			if (found) return {config, marker: found as GutterMarker, look: this.gutters.look(found, this)}
		}
		return null
	}

	/// Lint markers open a tooltip on hover: a tap on one shows that
	/// instead of running other gutters' handlers.
	private gutterHasHover(config: {class: string}) { return /cm-gutter-lint/.test(config.class) }

	private activateMarker(col: number, n: number, type: string) {
		let dom = this.markerAt(col, n)?.look.dom ?? null
		if (!dom) return false
		let at = col + ":" + n
		if (this.markerProxyAt == at && this.markerProxy == dom) return true
		this.clearMarkerProxy()
		let box = this.overlayMarkers ? this.overlayBox(n) : {x: col * this.gutterColumnWidth, w: this.gutterColumnWidth}, el = dom as HTMLElement
		let top = this.rowTop(this.gutterRow(n).row) - this.top
		Object.assign(el.style, {position: "absolute", left: box.x + "px", top: top + "px",
			width: Math.max(box.w, 4) + "px", height: this.lineHeight + "px", visibility: "hidden", pointerEvents: "none"})
		this.scrollDOM.appendChild(el)
		this.markerProxy = el
		this.markerProxyAt = at
		this.markerProxyLine = n
		this.markerProxyTop = top
		el.dispatchEvent(new MouseEvent(type, {bubbles: true}))
		return true
	}

	/// Keep the marker proxy over its line's marker as the view scrolls:
	/// gutter tooltips (lint) are positioned from its rect, and re-measure
	/// on the scroll notification that follows. Runs after drawing.
	private placeMarkerProxy() {
		let el = this.markerProxy
		if (!el) return
		let n = this.markerProxyLine
		if (n > this.state.doc.lines) { this.clearMarkerProxy(); return }
		let top = this.rowTop(this.gutterRow(n).row) - this.top
		if (top != this.markerProxyTop) {
			this.markerProxyTop = top
			el.style.top = top + "px"
		}
	}

	private clearMarkerProxy() {
		if (this.markerProxy) {
			this.markerProxy.dispatchEvent(new MouseEvent("mouseout", {bubbles: true}))
			this.markerProxy.remove()
		}
		this.markerProxy = null
		this.markerProxyAt = ""
	}

	/// A touch on `row` near its top or bottom edge goes to the line on
	/// that side when the touched line has nothing there (`has`) and that
	/// one does (`wanted`).
	private touchSnap(y: number, row: number, line: number, wanted: (n: number) => boolean, has: (n: number) => boolean) {
		if (has(line)) return line
		let frac = (y - this.rowTop(row)) / this.lineHeight
		let other = frac < TOUCH_EDGE ? row - 1 : frac > 1 - TOUCH_EDGE ? row + 1 : -1
		if (other < 0 || other >= this.lines.totalRows) return line
		let n = this.lines.lineAtRow(other).line
		return n != line && wanted(n) ? n : line
	}

	/// Whether the visual line starting at `n` can be folded or unfolded.
	private canFold(n: number) {
		let state = this.state, vl = this.lines.vline(n), folded = false
		foldedRanges(state).between(vl.from, vl.to, () => { folded = true })
		let line = state.doc.line(vl.first)
		return folded || !!foldable(state, line.from, line.to)
	}

	/// Fold or unfold the visual line starting at line `n`. Returns
	/// whether there was anything to toggle.
	toggleFold(n: number) {
		let state = this.state, vl = this.lines.vline(n)
		let folded: {from: number, to: number} | null = null
		foldedRanges(state).between(vl.from, vl.to, (from, to) => { if (!folded) folded = {from, to} })
		if (folded) {
			this.dispatch({effects: unfoldEffect.of(folded)})
			return true
		}
		let line = state.doc.line(vl.first)
		let range = foldable(state, line.from, line.to)
		if (!range) return false
		let effects: StateEffect<unknown>[] = [foldEffect.of(range)]
		if (!state.field(foldState, false)) effects.unshift(StateEffect.appendConfig.of(codeFolding()))
		this.dispatch({effects})
		return true
	}

	/// Client coordinates of the bottom of `pos`'s row at its x, where
	/// selection handles attach.
	handleAnchor(pos: number, side = 1) {
		let {row, x} = this.posCoords(pos, side), rect = this.surfaceRect()
		return {
			x: rect.left + this.contentLeft + x * this.cellWidth - this.left,
			y: rect.top + this.rowTop(row) - this.top + this.lineHeight
		}
	}

	private preventContextMenu = (e: Event) => { if (!this.blocks.contains(e.target)) e.preventDefault() }

	/// Mouse over the gutter shows every fold marker in "fade" mode.
	private onPointerHover = (e: PointerEvent) => {
		// Hover is a mouse thing: touches activate markers by tapping.
		if (e.pointerType != "mouse") return
		if (e.type == "pointermove") this.plugins.handle("mousemove", e)
		let x = e.clientX - this.surfaceRect().left, mouse = e.type == "pointermove"
		let line = mouse && x < this.gutterWidth ? this.lines.lineAtRow(this.rowAtHeight(e.clientY - this.surfaceRect().top + this.top)).line : 0
		if (mouse && (x < this.gutterLeft || line && this.onOverlayMarker(x, line))) {
			if (!this.activateMarker(this.overlayMarkers ? 0 : Math.floor(x / this.gutterColumnWidth), line, "mouseover"))
				this.clearMarkerProxy()
		} else if (this.markerProxy) {
			this.clearMarkerProxy()
		}
		let over = mouse && this.lineNumbers && x < this.gutterWidth && x >= this.gutterLeft
		if (over != this.gutterHover) {
			this.gutterHover = over
			this.dynKey = []
			this.requestFrame()
		}
	}

	private preventFocusLoss = (e: MouseEvent) => {
		// A press inside the selection keeps its default: it may start a drag.
		if (this.mouseSelection?.dragging === null) return
		if (e.target != this.input.element && !this.blocks.contains(e.target)) e.preventDefault()
	}

	/// Mouse click counting (pointer events carry no click count).
	private lastClick = {time: 0, x: 0, y: 0, count: 0}
	private mouseHost: MouseHost
	private mouseSelection: MouseSelection | null = null
	private dragDrop: TextDragDrop
	/// Where dragged text would be dropped (drawn as a cursor).
	private dropPos: number | null = null
	private focusHeld = false

	/// Mouse selection follows CodeMirror: `EditorView.mouseSelectionStyle`
	/// providers (`rectangularSelection`) first, then the default style
	/// (click, double click word, triple click line, shift extends,
	/// `clickAddsSelectionRange` adds a cursor). A press inside the
	/// selection may start a native text drag instead.
	private onMouseDown = (e: PointerEvent) => {
		if (e.pointerType != "mouse" || this.blocks.contains(e.target)) return
		if (e.button == 0 && this.stickyClick(e.clientX, e.clientY, e)) return
		let c = this.lastClick
		c.count = e.timeStamp - c.time < 400 && Math.abs(e.clientX - c.x) < 4 && Math.abs(e.clientY - c.y) < 4 ? c.count % 3 + 1 : 1
		c.time = e.timeStamp
		c.x = e.clientX
		c.y = e.clientY
		this.mouseSelection?.destroy()
		let mustFocus = !this.hasFocus
		this.focus()
		if (this.plugins.handle("mousedown", e) || this.clickSpecial(e.clientX, e.clientY, e)) {
			e.preventDefault()
			return
		}
		let style: MouseSelectionStyle | null = null
		for (let make of this.state.facet(EditorView.mouseSelectionStyle)) {
			style = make(this as any, e) as MouseSelectionStyle | null
			if (style) break
		}
		if (!style && e.button == 0) style = basicMouseSelection(this.mouseHost, e, c.count)
		if (!style) {
			e.preventDefault()
			return
		}
		let sel = this.mouseSelection = new MouseSelection(this.mouseHost, e, style, mustFocus, c.count, () => {
			if (this.mouseSelection == sel) this.mouseSelection = null
			// A press after a drag starts a new click count.
			if (sel.moved || this.dragDrop.dragged) c.time = 0
			if (!this.dragDrop.dragged) this.scrollDOM.draggable = false
		})
		// The press must not be cancelled for a native drag to start.
		if (sel.dragging === null) this.dragDrop.prepare()
		else e.preventDefault()
		sel.start()
	}

	/// While held, focus changes (a native drag starting moves focus
	/// off the input element for a moment) are not reported.
	private holdFocus(hold: boolean) {
		this.focusHeld = hold
		if (!hold && this.hasFocus != this.focused) this.onFocusChange(this.hasFocus)
	}

	/// Show the drop cursor of a text drag at `pos` (null hides it).
	setDropPos(pos: number | null) {
		if (pos == this.dropPos) return
		this.dropPos = pos
		this.dynKey = []
		this.requestFrame()
	}

	/// Start a fling with a velocity in CSS px/s, as if released by a finger.
	fling(vx: number, vy: number) {
		this.scroller.fling(vx, vy)
	}

	get scrollSpeed() {
		let s = this.config.scrollSpeed ?? 1
		if (typeof s == "number") return Math.max(0.1, Math.min(5, s))
		return {slow: 0.6, normal: 1, fast: 1.5, fastX2: 2.2}[s] ?? 1
	}

	/// Change options that can be updated live (`scrollSpeed`,
	/// `scrollPastEnd`, `horizontalScrollPastEnd`, `foldMarkers`,
	/// `wrapIndent`, `lineWrapping`, `indentGuides`, `lineNumbers`,
	/// `cursorBlinkRate`, `stickyScroll`, `fontLigatures`...).
	reconfigure(options: Pick<CanvasViewConfig, "scrollSpeed" | "scrollPastEnd" | "horizontalScrollPastEnd" | "foldMarkers" |
		"wrapIndent" | "lineWrapping" | "textDirection" | "indentGuides" | "lineNumbers" | "cursorBlinkRate" | "highlightActiveLine" | "cursorWidth" |
		"placeholder" | "showWhitespace" | "onLineNumberClick" | "rainbowBrackets" | "gutterMarkers" | "readOnlyCursor" | "stickyScroll" |
		"fontLigatures">) {
		Object.assign(this.config, options)
		if ("fontLigatures" in options) this.syncLigatures()
		if ("readOnlyCursor" in options) this.syncWritable()
		if ("lineNumbers" in options) {
			this.lineNumbers = (options.lineNumbers ?? true) !== false
			this.relativeNumbers = options.lineNumbers == "relative"
		}
		if ("cursorBlinkRate" in options) this.restartBlink()
		if ("scrollPastEnd" in options) {
			let past = options.scrollPastEnd ?? true
			this.scrollPastEnd = past === true ? 1 : past === false ? 0 : Math.max(0, Math.min(1, past))
		}
		this.syncWrapping()
		this.scrollTop = this.top
		this.scrollLeft = this.left
		this.dynKey = []
		this.sticky.key = []
		this.scene.reset(this.scene.origin)
		this.requestFrame()
	}

	/// Whether the view is being dragged or is flinging.
	get scrolling() { return this.scroller.active }

	// ---- Focus, cursor, IME ----------------------------------------------------

	/// Whether the editor's content can be focused for editing
	/// (`EditorView.editable`, like CodeMirror's contenteditable).
	get editable() { return this.state.facet(EditorView.editable) }

	focus() { if (this.editable) this.input.focus() }

	/// A read-only or non-editable editor keeps selection, cursor and
	/// copy, but never opens the on-screen keyboard.
	private syncWritable() {
		let writable = this.editable && !this.state.readOnly, el = this.input.element
		this.steadyCursor = !this.editable && (this.config.readOnlyCursor ?? true)
		el.inputMode = writable ? "text" : "none"
		if (el instanceof HTMLTextAreaElement) el.readOnly = !writable
		// Becoming read-only while focused drops focus: a new inputmode
		// isn't guaranteed to close a keyboard that's already open. The
		// next tap focuses again, without one.
		if (this.hasFocus && (!this.editable || (this.writable && !writable))) this.input.blur()
		this.writable = writable
		this.syncContentAttributes()
	}

	private writable = true

	/// `EditorView.contentAttributes` (spellcheck, autocorrect,
	/// autocapitalize...) apply to the input element, as they decide how
	/// on-screen keyboards behave. A `cursor` in their style (e.g.
	/// `crosshairCursor`) goes to the surface. Recomputed on every
	/// update, like CodeMirror, since providers can be functions of the view.
	private syncContentAttributes() {
		let attrs: {[name: string]: string} = {}, el = this.input.element, cursor = ""
		for (let source of this.state.facet(EditorView.contentAttributes)) {
			let value = typeof source == "function" ? (source as any)(this) : source
			if (!value) continue
			for (let name in value) {
				if (name == "style") cursor = /(?:^|;)\s*cursor\s*:\s*([^;]+)/.exec(value[name])?.[1].trim() ?? cursor
				else if (!/^(class|contenteditable|role|tabindex|inputmode)$/i.test(name)) attrs[name] = value[name]
			}
		}
		for (let name of this.contentAttrs) if (!(name in attrs)) el.removeAttribute(name)
		for (let name in attrs) if (el.getAttribute(name) != attrs[name]) el.setAttribute(name, attrs[name])
		this.contentAttrs = Object.keys(attrs)
		if (this.scrollDOM.style.cursor != cursor) this.scrollDOM.style.cursor = cursor
	}

	private contentAttrs: string[] = []

	get hasFocus() { return this.input.hasFocus() }

	/// The element receiving text input (CodeMirror's `contentDOM`).
	get contentDOM() { return this.input.element }

	get composing() { return this.input.composing }

	get compositionStarted() { return this.input.composing }

	onFocusChange(focused: boolean) {
		if (this.focusHeld) return
		this.focused = focused
		this.restartBlink()
		this.dynKey = []
		this.requestFrame()
		let notify = () => {
			if (this.destroyed) return
			let effects = this.plugins.focusEffects(focused)
			this.applyUpdate(effects.length ? [this.state.update({effects})] : [], 1)
		}
		if (this.plugins.isUpdating) queueMicrotask(notify)
		else notify()
	}

	/// Run CodeMirror `eventHandlers` (e.g. from `EditorView.domEventHandlers`)
	/// for an input event; true when one handled it.
	runEventHandlers(type: string, event: Event) {
		return this.plugins.handle(type, event)
	}

	private restartBlink() {
		if (this.blinkTimer != null) clearTimeout(this.blinkTimer)
		this.blinkTimer = null
		this.cursorOn = true
		let rate = this.config.cursorBlinkRate ?? 1200
		if (!this.focused || rate <= 0) return
		let tick = () => {
			this.cursorOn = !this.cursorOn
			this.requestFrame()
			this.blinkTimer = setTimeout(tick, rate / 2)
		}
		this.blinkTimer = setTimeout(tick, rate / 2)
	}

	setComposition(ranges: {from: number, to: number, thick: boolean}[] | null) {
		this.composition = ranges
		this.dynKey = []
		this.requestFrame()
	}

	charRect(pos: number) {
		let doc = this.state.doc
		if (pos < 0 || pos >= doc.length) return null
		let a = this.posCoords(pos, 1), b = this.posCoords(Math.min(doc.length, pos + 1), -1)
		let rect = this.surfaceRect(), cw = this.cellWidth
		// A right-to-left character's end is left of its start.
		let lo = b.row == a.row && b.x != a.x ? Math.min(a.x, b.x) : a.x, hi = b.row == a.row && b.x != a.x ? Math.max(a.x, b.x) : a.x + 1
		let x1 = this.contentLeft + lo * cw - this.left, x2 = this.contentLeft + hi * cw - this.left
		return new DOMRect(rect.left + x1, rect.top + this.rowTop(a.row) - this.top, Math.max(1, x2 - x1), this.lineHeight)
	}

	cursorRect() {
		let main = this.state.selection.main
		let c = this.coordsAtPos(main.head, main.assoc)
		return new DOMRect(c.left, c.top, 1, c.bottom - c.top)
	}

	// ---- EditorView-compatible surface ----------------------------------------
	// What CodeMirror commands and view plugins use.

	get defaultLineHeight() { return this.lineHeight }
	get defaultCharacterWidth() { return this.cellWidth }
	get lineWrapping() { return this.wrapping }
	get root() { return document }
	get win() { return window }
	get inView() { return true }
	get textDirection() { return this.lines.direction == "rtl" ? Direction.RTL : Direction.LTR }
	get scaleX() { return 1 }
	get scaleY() { return 1 }
	get themeClasses() { return this.plugins.themeClasses }
	/// The few `viewState` fields plugins read.
	get viewState() { return {scaleX: 1, scaleY: 1, printing: false} }
	/// Hover tooltips look up the DOM tile under the pointer.
	readonly docView = {tile: {nearest: () => ({isWidget: () => false, posAtStart: 0})}}
	get documentTop() { return this.surfaceRect().top + PAD_TOP - this.top }
	get documentPadding() { return {top: PAD_TOP, bottom: PAD_TOP} }
	get contentHeight() { return this.lines.totalRows * this.lineHeight + this.rowsTop + PAD_TOP }

	/// The range reported to plugins as visible (with a margin, updated
	/// when the visible rows leave it).
	get viewport() {
		if (this.vp.last < 0) this.updateViewportRows()
		let lines = this.lines, doc = this.state.doc
		let first = lines.lineAtRow(this.vp.first).line, last = lines.vline(lines.lineAtRow(this.vp.last).line)
		return {from: doc.line(first).from, to: last.to}
	}
	get visibleRanges() { return [this.viewport] }
	get viewportLineBlocks() {
		let {from, to} = this.viewport, out = []
		for (let pos = from; pos <= to;) {
			let block = this.lineBlockAt(pos)
			out.push(block)
			pos = block.to + 1
		}
		return out
	}

	textDirectionAt(pos: number) {
		return this.lines.baseLevel(this.state.doc.lineAt(Math.max(0, Math.min(this.state.doc.length, pos))).text) ? Direction.RTL : Direction.LTR
	}

	/// Level runs of a line in visual order, like CodeMirror's.
	bidiSpans(line: {text: string}) {
		return this.lines.lineSpans(line.text).map(s => new (BidiSpan as any)(s.from, s.to, s.level) as BidiSpan)
	}

	setTabFocusMode(_to?: boolean | number) {}

	requestMeasure<T>(req?: MeasureRequest<T>) { this.plugins.requestMeasure(req) }

	/// The view an element belongs to, like CodeMirror's
	/// `EditorView.findFromDOM` (which also finds canvas views): the
	/// view whose content is inside `dom` (e.g. a view's `dom`, or a
	/// container holding it), or the view of `dom` itself (its
	/// `dom`, `scrollDOM` or `contentDOM`, or a widget's DOM).
	static findFromDOM(dom: HTMLElement): CanvasView | null {
		let content = dom.querySelector?.(".cv-input")
		let found = (content && domViews.get(content)) || domViews.get(dom)
		return found instanceof CanvasView && !found.destroyed ? found : null
	}

	/// The view plugin instance for a CodeMirror ViewPlugin, if hosted.
	plugin<T extends object>(plugin: ViewPlugin<T, any>): T | null { return this.plugins.get(plugin) }

	lineBlockAt(pos: number) {
		let vl = this.lines.vline(this.state.doc.lineAt(Math.max(0, Math.min(this.state.doc.length, pos))).number)
		let top = this.rowTop(this.lines.rowOf(vl.first)) - PAD_TOP, height = vl.rows * this.lineHeight
		let widget = vl.cover ? vl.cover.deco.spec.widget ?? null : null
		return {from: vl.from, to: vl.to, length: vl.to - vl.from, top, height, bottom: top + height,
			type: vl.cover ? BlockType.WidgetRange : BlockType.Text, widget,
			widgetLineBreaks: vl.cover ? vl.last - vl.first : 0} as any
	}

	lineBlockAtHeight(height: number) {
		return this.lineBlockAt(this.state.doc.line(this.lineAtHeight(height + PAD_TOP)).from)
	}

	elementAtHeight(height: number) { return this.lineBlockAtHeight(height) }

	/// Position of a DOM node: widget label elements map to their widget.
	posAtDOM(node: Node, _offset = 0) {
		for (let n: Node | null = node; n; n = n.parentNode) {
			let widget = n instanceof HTMLElement ? this.decos.widgetDOM.get(n) : undefined
			if (widget) {
				let found = this.state.selection.main.head
				for (let p of this.decos.points) if ((p.deco.spec.widget as unknown) === widget) { found = p.from; break }
				return found
			}
		}
		return this.state.selection.main.head
	}

	domAtPos(_pos: number) { return {node: this.contentDOM, offset: 0} }

	/// Like CodeMirror, `forward` is toward the line's visual end in its
	/// base direction: in bidi text the cursor moves visually.
	moveByChar(start: SelectionRange, forward: boolean, by?: (initial: string) => (next: string) => boolean): SelectionRange {
		return this.skipAtoms(start, this.charMotion(start, forward, by))
	}

	/// The values of `EditorView.atomicRanges` for this view.
	private atoms() {
		let fs = this.state.facet(EditorView.atomicRanges)
		return fs.length ? fs.map(f => f(this as any)) : []
	}

	/// Cursor motion steps over atomic ranges (CodeMirror's `skipAtoms`).
	private skipAtoms(start: SelectionRange, pos: SelectionRange) {
		let atoms = this.atoms()
		if (!atoms.length) return pos
		let next = skipAtomicRanges(atoms, pos.from, start.head > pos.from ? -1 : 1)
		return next == pos.from ? pos : EditorSelection.cursor(next, next < pos.from ? 1 : -1)
	}

	private charMotion(start: SelectionRange, forward: boolean, by?: (initial: string) => (next: string) => boolean): SelectionRange {
		let doc = this.state.doc
		if (this.lines.direction != "ltr" || rtlChars.test(doc.lineAt(start.head).text)) return this.moveVisual(start, forward, by)
		let pos = start.head, check: ((next: string) => boolean) | null = null
		for (;;) {
			let line = doc.lineAt(pos), next: number, char: string
			if (forward ? pos == line.to : pos == line.from) {
				if (forward ? line.number == doc.lines : line.number == 1) return EditorSelection.cursor(pos)
				next = forward ? pos + 1 : pos - 1
				char = "\n"
			} else {
				next = line.from + findClusterBreak(line.text, pos - line.from, forward)
				char = doc.sliceString(Math.min(pos, next), Math.max(pos, next))
			}
			// Replaced ranges (folds, widgets that replace text) are atomic.
			let skipped = this.skipReplaced(next, forward)
			if (skipped != next) {
				char = doc.sliceString(Math.min(pos, skipped), Math.max(pos, skipped))
				next = skipped
			}
			if (!check) {
				if (!by) return EditorSelection.cursor(next, forward ? -1 : 1)
				check = by(char)
			} else if (!check(char)) {
				return EditorSelection.cursor(pos, forward ? -1 : 1)
			}
			pos = next
		}
	}

	/// CodeMirror's visual `moveByChar` (bidi text), with replaced
	/// ranges skipped as atomic.
	private moveVisual(start: SelectionRange, forward: boolean, by?: (initial: string) => (next: string) => boolean): SelectionRange {
		let doc = this.state.doc, lines = this.lines
		let line = doc.lineAt(start.head), spans = lines.lineSpans(line.text), dir = lines.baseLevel(line.text)
		let step = (pos: number, fwd: boolean) => findClusterBreak(line.text, pos, fwd)
		for (let cur = start, check: ((next: string) => boolean) | null = null;;) {
			let next: SelectionRange, char: string
			let moved = moveVisually(line.length, spans, dir, cur.head - line.from, cur.assoc, cur.bidiLevel ?? -1, forward, step)
			if (!moved) {
				if (line.number == (forward ? doc.lines : 1)) return cur
				char = "\n"
				line = doc.line(line.number + (forward ? 1 : -1))
				spans = lines.lineSpans(line.text)
				dir = lines.baseLevel(line.text)
				let side = lineSide(spans, dir, !forward)
				next = EditorSelection.cursor(line.from + side.pos, side.assoc)
			} else {
				let pos = line.from + moved.pos
				char = doc.sliceString(Math.min(pos, cur.head), Math.max(pos, cur.head))
				next = EditorSelection.cursor(pos, moved.assoc, moved.level)
			}
			let skipped = this.skipReplaced(next.head, next.head > cur.head)
			if (skipped != next.head) {
				char = doc.sliceString(Math.min(cur.head, skipped), Math.max(cur.head, skipped))
				next = EditorSelection.cursor(skipped, next.assoc)
			}
			if (!check) {
				if (!by) return next
				check = by(char)
			} else if (!check(char)) {
				return cur
			}
			cur = next
		}
	}

	/// Move a position out of a replaced range, in the direction of motion.
	private skipReplaced(pos: number, forward: boolean) {
		if (!this.decos.points.length) return pos
		let vl = this.lines.vline(this.state.doc.lineAt(pos).number)
		if (!vl.pieces) return pos
		for (let p of vl.pieces) {
			if (p.kind != PieceKind.Replace) continue
			let a = vl.from + p.from, b = vl.from + p.to
			if (pos > a && pos < b) return forward ? b : a
		}
		return pos
	}

	moveByGroup(start: SelectionRange, forward: boolean): SelectionRange {
		return this.moveByChar(start, forward, initial => {
			let categorize = this.state.charCategorizer(start.head)
			let cat = categorize(initial)
			return next => {
				let nextCat = categorize(next)
				if (cat == CharCategory.Space) cat = nextCat
				return cat == nextCat
			}
		})
	}

	moveToLineBoundary(start: SelectionRange, forward: boolean, includeWrap = true): SelectionRange {
		let {vl} = this.posCoords(start.head, start.assoc || 1)
		if (includeWrap && vl.breakPos) {
			let r = this.lines.rowAt(vl, start.head - vl.from, start.assoc || 1)
			if (forward) {
				if (r < vl.breakPos.length) return EditorSelection.cursor(vl.from + vl.breakPos[r], -1)
			} else if (r > 0) {
				return EditorSelection.cursor(vl.from + vl.breakPos[r - 1], 1)
			}
		}
		return EditorSelection.cursor(forward ? vl.to : vl.from, forward ? -1 : 1)
	}

	moveVertically(start: SelectionRange, forward: boolean, distance?: number): SelectionRange {
		return this.skipAtoms(start, this.verticalMotion(start, forward, distance))
	}

	private verticalMotion(start: SelectionRange, forward: boolean, distance?: number): SelectionRange {
		let {row, x, vl: from} = this.posCoords(start.head, start.assoc)
		let goal = start.goalColumn ?? x * this.cellWidth
		// From a block replace's edge, leave it in the direction moved.
		if (from.cover) row = this.lines.rowOf(from.first) + (forward ? Math.max(0, from.rows - 1) : 0)
		let inside = from.inner && this.lines.innerAt(from, row - this.lines.rowOf(from.first))
		if (inside) row = this.lines.rowOf(from.first) + inside.row + (forward ? inside.rows - 1 : 0)
		let rows = distance ? Math.max(1, Math.round(distance / this.lineHeight)) : 1
		let target = row + (forward ? rows : -rows)
		// Block widget rows hold no text: step over them.
		for (let i = 0; i < 100 && target >= 0 && target < this.lines.totalRows; i++) {
			let {line, rowStart} = this.lines.lineAtRow(target)
			let vl = this.lines.vline(line)
			// Into a block replace: stop at its near edge.
			if (vl.cover && target - rowStart < vl.rows)
				return EditorSelection.cursor(forward ? vl.from : vl.to, forward ? 1 : -1, undefined, goal)
			let b = vl.inner && this.lines.innerAt(vl, target - rowStart)
			if (b) return EditorSelection.cursor(forward ? b.point.from : b.point.to, forward ? 1 : -1, undefined, goal)
			if (target - rowStart < vl.rows) break
			target = forward ? rowStart + vl.rows + vl.blockRows : rowStart + vl.rows - 1
		}
		if (target < 0) return EditorSelection.cursor(0, 1, undefined, goal)
		if (target >= this.lines.totalRows) return EditorSelection.cursor(this.state.doc.length, -1, undefined, goal)
		let {pos, side} = this.posAtRow(target, goal / this.cellWidth)
		return EditorSelection.cursor(pos, side, undefined, goal)
	}

	coordsForChar(pos: number) {
		let r = this.charRect(pos)
		return r && {left: r.left, right: r.right, top: r.top, bottom: r.bottom}
	}

	noteInput(time: number) {
		this.lastInput = performance.now()
		if (this.pendingInput < 0) this.pendingInput = time
	}

	// ---- Frame loop ---------------------------------------------------------

	requestFrame() {
		if (this.frameRequested || this.destroyed) return
		this.frameRequested = true
		requestAnimationFrame(this.frame)
	}

	private frame = (time: number) => {
		this.frameRequested = false
		this.draw(time)
	}

	private draw(time: number) {
		if (this.destroyed || !this.backend) return
		if (this.lineHeightUnread && this.dom.isConnected) this.syncLineHeight()
		if (this.stylesPending && this.dom.isConnected) {
			this.stylesPending = false
			this.resetStyles()
		}
		let start = performance.now()
		let animating = this.scroller.step(time)
		this.prepareRows()
		let t0a = performance.now()
		// Plugins see the new viewport in a task of their own after this
		// frame; it runs ahead of what's drawn, so lines get their
		// decorations before they're emitted.
		if (this.updateViewportRows()) this.scheduleViewportUpdate()
		let t0b = performance.now()
		let rebuilt = this.ensureScene(start)
		let t1 = performance.now()
		this.buildDynamic()
		this.buildSticky()
		let t2 = performance.now()
		if (this.foldFading) {
			this.dynKey = []
			animating = true
		}
		let uploads = this.atlas.uploadedTexels
		this.backend.syncAtlas(this.atlas)
		let t3 = performance.now()
		this.backend.render(this.theme.background, this.passes())
		this.placeMagnifier()
		this.placeBlocks()
		this.clipBlocks()
		this.placeMarkerProxy()
		let end = performance.now()
		if (this.recordStats) {
			this.stats.push({
				time, work: end - start, rebuilt, glyphs: this.scene.glyphs.count,
				sceneMs: t1 - start, dynMs: t2 - t1, atlasMs: t3 - t2, renderMs: end - t3, rowsMs: t0a - start, viewportMs: t0b - t0a,
				atlasTexels: this.atlas.uploadedTexels - uploads,
				plainLines: this.coverage.plain, approxLines: this.coverage.approx,
				latency: this.pendingInput >= 0 ? end - this.pendingInput : -1,
				scrollTop: this.top
			})
		}
		this.pendingInput = -1
		this.lastFrameTop = this.top
		// After drawing: scroll notifications, then plugin measuring
		// (tooltip positions), which may read the DOM.
		let seen = this.lastObservedScroll
		if (seen.top != this.top || seen.left != this.left) {
			seen.top = this.top
			seen.left = this.left
			let event = new Event("scroll")
			this.plugins.observe("scroll", event)
			this.scrollDOM.dispatchEvent(event)
		}
		this.plugins.runMeasures()
		this.scheduleTreeSync()
		if (animating) this.requestFrame()
		if (!this.lines.identity && this.lines.dirty) this.scheduleIdleMeasure()
		if (this.atlas.ligaturesWanted && !this.probeTimer) this.probeTimer = setTimeout(this.probeLigatures, 0)
	}

	private probeTimer: ReturnType<typeof setTimeout> | 0 = 0

	/// Find out, in a task after the frame, whether the font has
	/// ligatures (once per font and page; ~0.3ms at 1×). Lines were
	/// drawn without them meanwhile; a font with them draws them again.
	private probeLigatures = () => {
		this.probeTimer = 0
		if (!this.destroyed && this.atlas.probeLigatures()) this.requestFrame()
	}

	/// Share the syntax driver's tree with the state's language field,
	/// so `syntaxTree(state)` users (folding, bracket matching,
	/// indentation, autocomplete) see the whole parse. CodeMirror's own
	/// background parse worker isn't run: its slices would drop frames
	/// during flings. When the driver's tree covers visible text the
	/// state's doesn't, it's shared in a task right after the frame;
	/// while the user scrolls or types, and for progress past the
	/// screen, at most every 250ms (each share is a transaction every
	/// plugin sees), and input arriving first shares it before it's
	/// handled (`flushTreeSync`).
	private scheduleTreeSync() {
		let pub = this.syntax.canonicalTree(this.state.doc)
		if (!pub || pub.id == this.syncedTree) return
		let urgent = !this.interacting && this.treeBehindScreen()
		if (this.treeSyncTimer != null) {
			if (!urgent || this.treeSyncUrgent) return
			clearTimeout(this.treeSyncTimer)
		}
		this.treeSyncUrgent = urgent
		this.treeSyncTimer = setTimeout(this.syncTree, urgent ? 0 : 250)
	}

	/// Whether the driver's tree covers visible text the state's doesn't.
	private treeBehindScreen() {
		let pub = this.syntax.canonicalTree(this.state.doc)
		return !!pub && syntaxTree(this.state).length < Math.min(pub.len, this.syntax.visibleEnd)
	}

	/// Before handling a key, text input or pointer press: share the
	/// tree now if the state's is short of the screen, so the command,
	/// input handler or tap acts on the parsed text.
	flushTreeSync() {
		if (!this.plugins.isUpdating && this.treeBehindScreen()) this.syncTree()
	}

	private onPointerDownFirst = () => this.flushTreeSync()

	private syncTree = () => {
		if (this.treeSyncTimer != null) clearTimeout(this.treeSyncTimer)
		this.treeSyncTimer = null
		if (this.destroyed) return
		if (this.plugins.isUpdating) {
			this.scheduleTreeSync()
			return
		}
		let state = this.state, pub = this.syntax.canonicalTree(state.doc)
		let field = state.field((Language as any).state, false) as any
		if (!pub || !field) return
		this.syncedTree = pub.id
		if (syntaxTree(state).length >= pub.len) return
		let partial = pub.len < state.doc.length
		let cx = new (ParseContext as any)(pub.parser, state, TreeFragment.addTree(pub.tree, [], partial), pub.tree, pub.len,
			{from: 0, to: pub.len}, [], null)
		this.dispatch({effects: (Language as any).setState.of(new field.constructor(cx))})
	}

	/// Measure the rows around the visible area (wrapping, folds) before
	/// drawing, keeping the top visible line in place when rows above
	/// it change.
	private prepareRows() {
		let lines = this.lines
		if (lines.identity) return
		let lh = this.lineHeight, screen = Math.ceil(this.height / lh) + 1
		for (let attempt = 0; attempt < 3; attempt++) {
			let topRow = this.rowAtHeight(this.top)
			let anchor = lines.lineAtRow(topRow)
			let offset = this.top - this.rowTop(anchor.rowStart)
			let a = lines.lineAtRow(topRow - screen).line, b = lines.lineAtRow(topRow + screen * 2).line
			let m = lines.measure(a, b, anchor.line)
			if (!m.total) break
			this.keepAnchor(anchor.line, offset)
		}
	}

	private keepAnchor(line: number, offset: number) {
		// Above the first row (in the padding or the head's block
		// widgets): let a growing head push the text down, so it shows.
		if (offset < 0) return
		let before = this.top
		let next = Math.max(0, Math.min(this.maxScrollTop, this.rowTop(this.lines.rowOf(line)) + offset))
		if (next != before) {
			this.top = next
			this.scroller.shift(next - before)
		}
	}

	/// Measure the rest of the document in idle slices (wrapping), so
	/// the scrollbar and jumps become exact.
	private scheduleIdleMeasure() {
		if (this.idleTimer != null) return
		let step = () => {
			this.idleTimer = null
			if (this.destroyed || this.lines.identity) return
			if (this.scroller.active) { this.idleTimer = setTimeout(step, 100); return }
			let topRow = this.rowAtHeight(this.top)
			let anchor = this.lines.lineAtRow(topRow)
			let offset = this.top - this.rowTop(anchor.rowStart)
			let res = this.lines.measureIdle(anchor.line, anchor.line, performance.now() + 4)
			if (res.total) {
				this.keepAnchor(anchor.line, offset)
				this.requestFrame()
			}
			if (!res.done) this.idleTimer = setTimeout(step, 16)
		}
		this.idleTimer = setTimeout(step, 30)
	}

	private visibleRows() {
		let firstRow = this.rowAtHeight(this.top), lastRow = this.rowAtHeight(this.top + this.height)
		return {firstRow, lastRow, first: this.lines.lineAtRow(firstRow).line, last: this.lines.lineAtRow(lastRow).line}
	}

	/// Move the plugin viewport when the visible rows get within 1.5
	/// screens (the scene's look-ahead) of its edge; it then extends 2.5
	/// screens past them. Returns whether it changed.
	private updateViewportRows() {
		let {firstRow, lastRow} = this.visibleRows(), vp = this.vp, total = this.lines.totalRows
		let screen = lastRow - firstRow + 1
		let lowOk = vp.first <= 0 || firstRow - vp.first >= screen * 1.5
		let highOk = vp.last >= total - 1 || vp.last - lastRow >= screen * 1.5
		if (vp.last >= 0 && lowOk && highOk && firstRow >= vp.first && lastRow <= vp.last) return false
		vp.first = Math.max(0, firstRow - Math.ceil(screen * 2.5))
		vp.last = Math.min(total - 1, lastRow + Math.ceil(screen * 2.5))
		return true
	}

	private viewportTask = false
	private viewportChannel: MessageChannel | null = null

	private scheduleViewportUpdate() {
		if (this.viewportTask) return
		this.viewportTask = true
		if (!this.viewportChannel) {
			this.viewportChannel = new MessageChannel()
			this.viewportChannel.port1.onmessage = () => {
				this.viewportTask = false
				if (this.destroyed) return
				if (this.plugins.isUpdating) { this.scheduleViewportUpdate(); return }
				this.applyUpdate([], 4 | 8)
			}
		}
		this.viewportChannel.port2.postMessage(null)
	}

	get gutterRight() { return this.gutterWidth - this.gutterPad }

	/// Bring the scene up to date for the visible lines, plus margins
	/// (biased in the scroll direction) while within a time budget.
	/// Returns whether any line was emitted.
	private ensureScene(start: number) {
		let {firstRow, lastRow, first, last} = this.visibleRows()
		let lines = this.lines, screen = lastRow - firstRow + 1
		let dir = Math.sign(this.top - this.lastFrameTop)
		let wantFirst = lines.lineAtRow(firstRow - Math.ceil(screen * (dir > 0 ? 0.5 : dir < 0 ? 1.5 : 1))).line
		let wantLast = lines.lineAtRow(lastRow + Math.ceil(screen * (dir < 0 ? 0.5 : dir > 0 ? 1.5 : 1))).line
		let cw = this.cellWidth, room = this.width - this.contentLeft
		let colFirst = Math.floor(this.left / cw), colLast = Math.ceil((this.left + room) / cw)
		let emitted = 0
		for (let attempt = 0; attempt < 2; attempt++) {
			let generation = this.atlas.generation
			let key = [this.atlas, generation, this.atlas.ligatures, this.atlas.ligatureVersion, this.theme, this.metrics, this.gutterWidth, this.lineNumbers, this.relativeNumbers, this.tabSize, lines.wrap,
				lines.bidiVersion,
				this.indentUnit, this.config.indentGuides, this.whitespace, this.rainbowState]
			this.scene.ensure(this.state.doc, this.syntax, first, last, wantFirst, wantLast, colFirst, colLast, firstRow, lastRow,
				key, start + 4, this.lineNumbers && !this.relativeNumbers, dir >= 0)
			emitted += this.scene.emitted
			// The atlas was cleared mid-way: entries emitted before are stale.
			if (this.atlas.generation == generation) break
		}
		if (this.recordStats) this.coverage = this.scene.coverage(first, last)
		return emitted > 0
	}

	private get syntaxHighlighter(): Highlighter | readonly Highlighter[] {
		return this.highlighters ?? this.theme.highlighter
	}

	private highlightStyleKey(): unknown[] {
		return this.highlighters ? [this.state.facet(EditorView.styleModule), this.plugins.themeClasses] : []
	}

	/// Syntax colors come from the state's highlighters, read from their
	/// CSS like in CodeMirror's DOM editor, or, when it has none, from the
	/// theme's \`highlight\`. Called after reconfiguration.
	private syncHighlighting() {
		let hl = stateHighlighters(this.state), same = sameHighlighters(hl, this.highlighters)
		this.highlighters = hl
		let key = this.highlightStyleKey()
		if (same && sameKey(key, this.highlightKey)) return
		this.highlightKey = key
		if (!same) this.syntax.setHighlighter(this.syntaxHighlighter)
		this.resetStyles()
		this.requestFrame()
	}

	styleForClass(id: number) {
		let style = this.classStyles[id]
		if (style == null) {
			let cls = this.syntax.classes[id]
			let tok = this.highlighters ? this.classReader.read(cls) : this.theme.tokenStyle(cls)
			if (!tok) {
				this.stylesPending = true
				return this.defaultStyle
			}
			let color = tok.color ?? this.theme.foreground
			style = this.classStyles[id] = this.addStyle(color, tok.bold, tok.italic)
			this.classDeco[id] = {bg: tok.background, underline: tok.underline, strike: tok.strike, color}
		}
		return style
	}

	/// Style id for a variant and color (mark overrides, widget labels).
	styleFor(variant: FontVariant, color: PackedColor) {
		let key = color * 4 + variant
		let found = this.variantStyles.get(key)
		if (found == null) {
			this.styles.push({variant, color})
			this.variantStyles.set(key, found = this.styles.length - 1)
		}
		return found
	}

	private addStyle(color: PackedColor, bold = false, italic = false) {
		this.styles.push({variant: fontVariant(bold, italic), color})
		return this.styles.length - 1
	}

	decoForClass(id: number) {
		if (this.classStyles[id] == null) this.styleForClass(id)
		return this.classDeco[id] ?? null
	}

	private get guideConfig() {
		let g = this.config.indentGuides ?? true
		return g === false ? null : {active: (g === true ? undefined : g.active) ?? true, hideOnBlankLines: g === true ? false : !!g.hideOnBlankLines}
	}

	get indentGuideColor() { return this.guideConfig ? this.theme.indentGuide : null }

	private rainbow: {key: unknown[], value: RainbowBrackets | null} = {key: [], value: null}

	private get rainbowState() {
		let c = this.config.rainbowBrackets ?? false, key = [c, this.theme]
		if (!key.every((v, i) => v === this.rainbow.key[i])) {
			let colors = c ? (c !== true && c.colors?.length ? c.colors : this.theme.dark ? darkRainbow : lightRainbow) : null
			this.rainbow = {key, value: colors ? new RainbowBrackets(colors.map(x => parseColor(x))) : null}
		}
		return this.rainbow.value
	}

	get rainbowColors() { return this.rainbowState?.colors ?? null }

	lineBrackets(n: number) {
		let r = this.rainbowState
		if (!r) return null
		let pub = this.syntax.canonicalTree(this.state.doc)
		return r.lineBrackets(this.state.doc, pub?.tree ?? null, pub?.len ?? 0, n)
	}

	/// New highlighting not caused by an edit (edits are mapped when
	/// they're applied, see `mapEdit`).
	syntaxChanged(pos: number) {
		this.rainbowState?.invalidateFrom(this.state.doc.lineAt(Math.min(pos, this.state.doc.length)).number)
	}

	private wsCache: {key: unknown[], value: WhitespaceStyle | null} = {key: [], value: null}

	/// Whitespace markers: from the config, or on when CodeMirror's
	/// whitespace highlighters are in the state.
	get whitespace(): WhitespaceStyle | null {
		let c = this.config.showWhitespace, key = [c, this.theme, this.plugins.specsVersion]
		if (key.every((v, i) => v === this.wsCache.key[i])) return this.wsCache.value
		let spaces: boolean, trailing: boolean, breaks: boolean
		if (c == null) {
			spaces = this.plugins.uses(nativeEquivalents.whitespace)
			trailing = this.plugins.uses(nativeEquivalents.trailingWhitespace)
			breaks = false
		} else if (typeof c == "boolean") {
			spaces = trailing = breaks = c
		} else {
			spaces = c.spaces ?? true
			trailing = c.trailing ?? true
			breaks = c.lineBreaks ?? false
		}
		let value = spaces || trailing || breaks
			? {color: this.theme.whitespace, trailing: trailing ? this.theme.trailingSpace : null, spaces, lineBreaks: breaks} : null
		this.wsCache = {key, value}
		return value
	}

	get indentUnit() { return Math.max(1, getIndentUnit(this.state) || this.tabSize) }

	/// Guide spacing for a line: the tab size for tab indentation (like
	/// VS Code), the indent unit otherwise.
	private guideStep(text: string) { return text.charCodeAt(0) == 9 ? this.tabSize : this.indentUnit }

	private guideOut = {indent: 0, step: 1}

	/// Indentation and guide spacing for line `n` (shared result object).
	guideInfo(n: number, text: string) {
		let out = this.guideOut
		out.indent = this.guideIndent(n, text, out)
		return out
	}

	/// Columns of leading whitespace (tabs to tab stops), or -1 for a blank line.
	private indentCols(text: string) {
		let cols = 0, tab = this.tabSize
		for (let i = 0; i < text.length; i++) {
			let c = text.charCodeAt(i)
			if (c == 32) cols++
			else if (c == 9) cols += tab - cols % tab
			else return cols
		}
		return -1
	}

	/// Indentation guides are drawn for on line `n`: its own, or for a
	/// blank line the smaller of the nearest non-blank lines around it.
	guideIndent(n: number, text: string, step?: {step: number}) {
		let own = this.indentCols(text)
		if (step) step.step = this.guideStep(text)
		if (own >= 0) return own
		if (this.guideConfig?.hideOnBlankLines) return 0
		let doc = this.state.doc, prev = -1, next = -1, prevText = "", nextText = ""
		for (let k = n - 1; k >= Math.max(1, n - 100) && prev < 0; k--) prev = this.indentCols(prevText = doc.line(k).text)
		for (let k = n + 1; k <= Math.min(doc.lines, n + 100) && next < 0; k++) next = this.indentCols(nextText = doc.line(k).text)
		if (step) step.step = this.guideStep(prev >= 0 ? prevText : nextText)
		return prev < 0 ? Math.max(0, next) : next < 0 ? prev : Math.min(prev, next)
	}

	/// After an edit, blank lines next to changed lines may need other
	/// guides: re-emit them.
	private invalidateBlankNeighbors(changes: ChangeDesc) {
		if (!this.guideConfig) return
		let doc = this.state.doc, ranges: number[] = []
		changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
			let a = doc.lineAt(fromB).number, b = doc.lineAt(toB).number
			while (a > 1 && b - a < 200 && this.indentCols(doc.line(a - 1).text) < 0) a--
			while (b < doc.lines && b - a < 400 && this.indentCols(doc.line(b + 1).text) < 0) b++
			ranges.push(doc.line(a).from, doc.line(b).to)
		})
		this.scene.invalidate(ranges)
	}

	/// The active indent guide: the block around the cursor, as a guide
	/// column and line range, or null.
	private activeGuide() {
		let doc = this.state.doc, unitOut = {step: 1}
		let n = doc.lineAt(this.state.selection.main.head).number
		// Right-to-left paragraphs draw no guides.
		if (this.lines.baseLevel(doc.line(n).text)) return null
		let indent = this.guideIndent(n, doc.line(n).text, unitOut), unit = unitOut.step
		// A line opening a more indented block shows that block's guide.
		let next = n < doc.lines ? this.guideIndent(n + 1, doc.line(n + 1).text) : -1
		let col: number, first: number
		if (next > indent) { col = Math.floor(indent / unit) * unit; first = n + 1 }
		else if (indent > 0) { col = Math.floor((indent - 1) / unit) * unit; first = n }
		else return null
		let inBlock = (k: number) => {
			let ind = this.indentCols(doc.line(k).text)
			return ind < 0 || ind > col
		}
		while (first > 1 && n - first < 2000 && inBlock(first - 1)) first--
		let last = Math.max(n, first)
		while (last < doc.lines && last - n < 2000 && inBlock(last + 1)) last++
		// Blank lines at the block's end don't belong to it.
		while (last > first && this.indentCols(doc.line(last).text) < 0) last--
		return {col, first, last}
	}

	/// A one-cell wave for wavy underlines (tinted like text).
	waveGlyph(): GlyphEntry {
		let dpr = this.dpr, w = this.metrics.cellWidthDev, h = Math.max(3, Math.round(3 * dpr))
		return this.atlas.shape(`wave-${w}-${h}`, w, h, cx => {
			cx.lineWidth = Math.max(1, dpr * 0.9)
			cx.beginPath()
			for (let x = 0; x <= w; x++) {
				let y = h / 2 + Math.sin(x / w * Math.PI * 2) * (h / 2 - cx.lineWidth / 2)
				if (x) cx.lineTo(x, y)
				else cx.moveTo(x, y)
			}
			cx.stroke()
		})
	}

	private imageKeys = new WeakMap<object, string>()
	private nextImageKey = 0

	/// A widget's own drawing, rasterized in color into the atlas.
	widgetImage(label: CanvasWidgetSpec, w: number, h: number): GlyphEntry {
		let key = label.key
		if (key == null) {
			key = this.imageKeys.get(label)
			if (key == null) this.imageKeys.set(label, key = "auto" + this.nextImageKey++)
		}
		let dw = Math.max(1, Math.round(w * this.dpr)), dh = Math.max(1, Math.round(h * this.dpr))
		return this.atlas.shape(`img-${key}-${dw}x${dh}`, dw, dh, cx => label.draw!(cx, dw, dh), true)
	}

	/// CodeMirror's lint point: a 6×4 px triangle pointing up (tinted).
	pointGlyph(): GlyphEntry {
		let dpr = this.dpr, w = Math.max(3, Math.round(6 * dpr)), h = Math.max(2, Math.round(4 * dpr))
		return this.atlas.shape(`point-${w}x${h}`, w, h, cx => {
			cx.beginPath()
			cx.moveTo(0, h)
			cx.lineTo(w / 2, 0)
			cx.lineTo(w, h)
			cx.closePath()
			cx.fill()
		})
	}

	roundedBox(w: number, h: number, outline: boolean): GlyphEntry {
		let dpr = this.dpr, dw = Math.max(2, Math.round(w * dpr)), dh = Math.max(2, Math.round(h * dpr)), r = Math.min(dw, dh) * 0.2
		return this.atlas.shape(`rbox-${outline ? "o" : "f"}-${dw}x${dh}`, dw, dh, cx => {
			cx.beginPath()
			if (outline) {
				let lw = Math.max(1, Math.round(dpr))
				cx.lineWidth = lw
				cx.roundRect(lw / 2, lw / 2, dw - lw, dh - lw, r)
				cx.stroke()
			} else {
				cx.roundRect(0, 0, dw, dh, r)
				cx.fill()
			}
		})
	}

	/// Font size in CSS px (widgets sized in em).
	get fontSizePx() { return this.font.size }

	/// The label drawn for a widget (decoration styles from the theme).
	private widgetSpec(widget: WidgetType): CanvasWidgetSpec {
		return this.decos.widgetSpec(widget, this as any)
	}

	private emitNumber(buf: InstanceBuffer, n: number, right: number, y: number, style: number) {
		let cw = this.cellWidth
		let str = String(n)
		for (let i = 0; i < str.length; i++) {
			let st = this.styles[style]
			let g = this.atlas.asciiGlyph(st.variant, str.charCodeAt(i))
			pushGlyph(buf, right - (str.length - i) * cw + g.ox, y + g.oy, g, st.color)
		}
	}

	private dynKey: unknown[] = []

	/// Gutter marker sets, so the dynamic layer is rebuilt when they change.
	private markerKey(): unknown[] {
		let out: unknown[] = [this.state.facet(gutterLineClass), this.state.facet(lineNumberMarkers), this.gutterClassVersion]
		for (let g of this.gutterColumns) out.push(...this.gutters.markerSets(g, this))
		return out
	}

	// ---- Gutter element classes ------------------------------------------------
	// CodeMirror gives each gutter element (one per gutter and line) the
	// `elementClass` of its markers, plus that of `gutterLineClass`
	// markers in every gutter. Their backgrounds are drawn as rects: the
	// theme's `classes` first, otherwise the CSS, read from a hidden
	// gutter element after the frame (never in it) and cached.

	/// Tints for this build: x, width (CSS px), first line, class key.
	private gutterTints: {x: number, w: number, line: number, key: string}[] = []
	private gutterClassColors = new Map<string, PackedColor | null>()
	private gutterClassPending = new Set<string>()
	private gutterClassTimer: ReturnType<typeof setTimeout> | null = null
	private gutterClassVersion = 0
	private gutterClassStyles: unknown[] = []

	private tintGutter(x: number, w: number, line: number, cls: string, gutterClass = "") {
		if (cls && cls != "cm-activeLineGutter") this.gutterTints.push({x, w, line, key: gutterClass + "\0" + cls})
	}

	/// Background of a gutter element class (null: none), or undefined
	/// while its CSS hasn't been read yet.
	private gutterClassColor(key: string): PackedColor | null | undefined {
		let found = this.gutterClassColors.get(key)
		if (found !== undefined) return found
		let themed: string | undefined
		for (let c of key.slice(key.indexOf("\0") + 1).split(" ")) themed = this.theme.classStyle(c)?.background ?? themed
		if (themed) {
			let color = parseColor(themed)
			this.gutterClassColors.set(key, color)
			return color
		}
		this.gutterClassPending.add(key)
		this.gutterClassTimer ??= setTimeout(() => this.readGutterClasses(), 0)
		return undefined
	}

	private readGutterClasses() {
		this.gutterClassTimer = null
		if (this.destroyed || !this.gutterClassPending.size) return
		let wrap = document.createElement("div")
		wrap.className = "cm-gutters"
		wrap.style.cssText = "position: absolute; left: 0; top: 0; visibility: hidden; pointer-events: none"
		let probes: [string, HTMLElement][] = []
		for (let key of this.gutterClassPending) {
			let gutter = document.createElement("div"), split = key.indexOf("\0")
			gutter.className = ("cm-gutter " + key.slice(0, split)).trim()
			let el = gutter.appendChild(document.createElement("div"))
			el.className = "cm-gutterElement " + key.slice(split + 1)
			wrap.appendChild(gutter)
			probes.push([key, el])
		}
		this.dom.appendChild(wrap)
		for (let [key, el] of probes) {
			let color = parseColor(getComputedStyle(el).backgroundColor)
			this.gutterClassColors.set(key, color >>> 24 ? color : null)
		}
		wrap.remove()
		this.gutterClassPending.clear()
		this.gutterClassVersion++
		this.requestFrame()
	}

	/// Tint gutter elements: `gutterLineClass` across the gutter, line
	/// number markers' classes in the number column, and the classes
	/// collected from the marker columns.
	private buildGutterClasses(rowY: (row: number) => number) {
		let state = this.state, doc = state.doc, lines = this.lines, {first, last} = this.selWindow
		// Theme CSS changed: read the classes again.
		let styles = [this.plugins.themeClasses, this.theme, state.facet(EditorView.styleModule)]
		if (styles.some((v, i) => v !== this.gutterClassStyles[i])) {
			this.gutterClassStyles = styles
			this.gutterClassColors.clear()
		}
		let from = doc.line(lines.lineAtRow(first).line).from, to = lines.vline(lines.lineAtRow(last).line).to
		let gw = this.gutterWidth - 1
		for (let set of state.facet(gutterLineClass))
			set.between(from, to, (pos, _to, m) => this.tintGutter(0, gw, doc.lineAt(pos).number, m.elementClass))
		if (this.lineNumbers) {
			let x = this.gutterLeft, w = this.gutterRight - this.gutterLeft
			for (let set of state.facet(lineNumberMarkers))
				set.between(from, to, (pos, _to, m) => this.tintGutter(x, w, doc.lineAt(pos).number, m.elementClass, "cm-lineNumbers"))
		}
		let gutter = this.gutterRects, lh = this.lineHeight
		for (let {x, w, line, key} of this.gutterTints) {
			if (lines.hidden(line) || lines.covered(line)) continue
			let color = this.gutterClassColor(key)
			if (color == null) continue
			let vl = lines.vline(line), row = lines.rowOf(vl.first)
			if (row + vl.rows > first && row <= last) pushRect(gutter, x, rowY(row), w, vl.rows * lh, color)
		}
		this.gutterTints.length = 0
	}

	private buildDynamic() {
		let t = this.theme
		let {firstRow, lastRow} = this.visibleRows()
		let w = this.selWindow
		if (firstRow < w.first || lastRow > w.last) {
			let screen = lastRow - firstRow + 1
			w.first = Math.max(0, firstRow - screen)
			w.last = lastRow + screen
		}
		let key = [this.state.selection, this.state.doc, this.scene.origin, w.first, w.last, this.theme, this.metrics, this.width,
			this.atlas.generation, this.composition, this.touchSelection.version, this.lines.version, foldedRanges(this.state), this.focused,
			this.gutterHover, syntaxTree(this.state), this.config.placeholder, this.config.highlightActiveLine, this.config.cursorWidth,
			this.relativeNumbers, this.dropPos, ...this.markerKey()]
		if (key.some((v, i) => v !== this.dynKey[i])) {
			this.dynKey = key
			this.buildSelectionLayers()
		}
		let th = this.thumbs, ch = this.scrollHeightPx, maxLeft = this.maxScrollLeft
		let room = this.width - this.contentLeft
		let vSize = ch > this.height ? Math.max(24, this.height * this.height / ch) : 0
		let hSize = maxLeft > 0 ? Math.max(24, room * room / (room + maxLeft)) : 0
		let thumbKey = [this.width, this.height, this.contentLeft, t]
		if (vSize != th.vSize || hSize != th.hSize || thumbKey.some((v, i) => v !== (th.key as unknown[] | null)?.[i])) {
			th.vSize = vSize
			th.hSize = hSize
			th.key = thumbKey
			this.vThumb.reset()
			this.hThumb.reset()
			if (vSize) pushRect(this.vThumb, this.width - SCROLLBAR - 2, 0, SCROLLBAR, vSize, t.scrollbar)
			if (hSize) pushRect(this.hThumb, this.contentLeft, this.height - SCROLLBAR - 2, hSize, SCROLLBAR, t.scrollbar)
		}
		th.vY = vSize && this.maxScrollTop ? this.top / this.maxScrollTop * (this.height - vSize) : 0
		th.hX = hSize ? this.left / maxLeft * (room - hSize) : 0
	}

	/// Call `f(row, x1, x2)` (x in cells from the row start) for each row
	/// piece of document range `from..to` within rows `first..last`.
	/// `extend` (the selection shape) adds a cell where the range
	/// continues past a line end, and starts wrapped continuation rows
	/// at the left edge, covering their indent (like VS Code), instead of
	/// at their text.
	private rangeRows(from: number, to: number, first: number, last: number, extend: boolean,
		f: (row: number, x1: number, x2: number) => void) {
		let lines = this.lines, doc = this.state.doc
		let startLine = lines.vlineStart(doc.lineAt(from).number)
		let firstVisible = lines.lineAtRow(first).line
		let n = Math.max(startLine, firstVisible), endLine = doc.lineAt(to).number
		while (n <= endLine && n <= doc.lines) {
			let vl = lines.vline(n), base = lines.rowOf(vl.first)
			if (base > last) break
			let endsHere = to <= vl.to
			if (vl.cover) {
				// A block replace: covered rows fill the text area when the
				// range reaches inside (only its edges are positions).
				if (from < vl.to && to > vl.from) {
					let right = (this.left + this.width - this.contentLeft) / this.cellWidth
					for (let r = Math.max(0, first - base); r < vl.rows && base + r <= last; r++) f(base + r, 0, right)
				}
				n = vl.last + 1
				continue
			}
			if (vl.bidi) {
				// Runs draw columns out of order: one piece per run.
				let ca = from > vl.from ? lines.colAt(vl, from - vl.from, 1) : 0
				let cb = endsHere ? lines.colAt(vl, to - vl.from, -1) : vl.width
				lines.colSpans(vl, ca, cb, (r, x, w) => { if (base + r >= first && base + r <= last) f(base + r, x, x + w) })
				let lastRow = base + vl.rows - 1
				if (!endsHere && extend && lastRow >= first && lastRow <= last) {
					let right = lines.rowRight(vl, vl.rows - 1)
					f(lastRow, right, right + 1)
				}
				n = vl.last + 1
				continue
			}
			if (vl.inner && extend) for (let b of vl.inner) {
				// A selection reaching inside a block replace fills its rows.
				if (from < b.point.to && to > b.point.from) {
					let right = (this.left + this.width - this.contentLeft) / this.cellWidth
					for (let r = b.row; r < b.row + b.rows; r++) if (base + r >= first && base + r <= last) f(base + r, 0, right)
				}
			}
			let a = from > vl.from ? lines.coordsIn(vl, from - vl.from, 1) : {row: 0, x: 0}
			let rowEnd = (r: number) => lines.rowEndCol(vl, r) - lines.rowStartCol(vl, r) + lines.rowX(vl, r)
			let b = endsHere ? lines.coordsIn(vl, to - vl.from, -1) : {row: vl.rows - 1, x: rowEnd(vl.rows - 1) + (extend ? 1 : 0)}
			for (let r = a.row; r <= b.row; r++) {
				if (base + r < first || base + r > last || vl.inner && lines.innerAt(vl, r)) continue
				let x1 = r == a.row ? a.x : extend ? 0 : lines.rowX(vl, r)
				let x2 = r == b.row ? b.x : rowEnd(r)
				if (x2 > x1 || r != b.row) f(base + r, x1, Math.max(x1, x2))
			}
			n = vl.last + 1
		}
	}

	private buildSelectionLayers() {
		let t = this.theme, origin = this.scene.origin
		let under = this.underRects, over = this.overRects, gutter = this.gutterRects
		under.reset()
		over.reset()
		gutter.reset()
		this.dynGlyphs.reset()
		this.placeholderGlyphs.reset()
		let doc = this.state.doc, sel = this.state.selection, lines = this.lines
		let lh = this.lineHeight, cw = this.cellWidth, gw = this.gutterWidth
		let {first, last} = this.selWindow
		let rowY = (row: number) => (row - origin) * lh

		// Active visual lines (by first line), with their rows.
		let active = new Map<number, {row: number, rows: number}>()
		for (let range of sel.ranges) {
			if (!range.empty) continue
			let vl = lines.vline(doc.lineAt(range.head).number)
			// Block replaces' widgets get no active line or number.
			if (!vl.cover && !active.has(vl.first)) active.set(vl.first, {row: lines.rowOf(vl.first), rows: vl.rows})
		}
		let highlightActive = this.config.highlightActiveLine ?? true
		if (highlightActive) for (let {row, rows} of active.values())
			if (row + rows > first && row <= last) pushRect(under, -FAR, rowY(row), 2 * FAR, rows * lh, t.activeLine)
		for (let range of sel.ranges) {
			if (range.empty) continue
			this.rangeRows(range.from, range.to, first, last, true, (row, x1, x2) =>
				pushRect(under, x1 * cw, rowY(row), (x2 - x1) * cw, lh, t.selection))
		}

		let cursors = this.cursorRects
		cursors.reset()
		// A touch selection shows its handles and no cursor, like native
		// Android fields and sora-editor (mouse and keyboard selections
		// keep CodeMirror's cursor at the head).
		let touchSelection = this.touchSelection.mode == "selection"
		for (let range of sel.ranges) {
			if (touchSelection && !range.empty) continue
			let {row, x} = this.posCoords(range.head, range.assoc)
			if (row < first || row > last) continue
			let cwidth = Math.max(1, Math.min(10, this.config.cursorWidth ?? 2))
			pushRect(cursors, x * cw - cwidth / 2, rowY(row), cwidth, lh, t.cursor)
		}
		// Drop position of dragged text (in the "over" pass: drawn while
		// blurred and blinking too).
		if (this.dropPos != null) {
			let {row, x} = this.posCoords(this.dropPos)
			let cwidth = Math.max(1, Math.min(10, this.config.cursorWidth ?? 2))
			if (row >= first && row <= last) pushRect(over, x * cw - cwidth / 2, rowY(row), cwidth, lh, t.cursor)
		}
		// IME composition underlines.
		for (let c of this.composition ?? []) {
			let thick = c.thick ? 2 : 1
			this.rangeRows(c.from, c.to, first, last, false, (row, x1, x2) =>
				pushRect(over, x1 * cw, rowY(row) + lh - thick - 1, Math.max(1, (x2 - x1) * cw), thick, t.foreground))
		}

		this.buildHandles(rowY)

		let guide = this.guideConfig?.active ? this.activeGuide() : null
		if (guide) {
			let r0 = Math.max(first, lines.rowOf(guide.first))
			let lastVl = lines.vline(guide.last), r1 = Math.min(last + 1, lines.rowOf(lastVl.first) + lastVl.rows)
			// Split where wrapped rows start left of the guide (like the
			// scene's guides), merging the spans of consecutive lines.
			let x = guide.col * cw, spanFrom = -1, spanTo = -1
			let flushSpan = () => { if (spanTo > spanFrom) pushRect(over, x, rowY(spanFrom), 1, (spanTo - spanFrom) * lh, t.activeIndentGuide) }
			for (let r = r0; r < r1;) {
				let {line, rowStart} = lines.lineAtRow(r), vl = lines.vline(line)
				let add = (a: number, b: number) => {
					a = Math.max(r0, rowStart + a); b = Math.min(r1, rowStart + b)
					if (b <= a) return
					if (a != spanTo) { flushSpan(); spanFrom = a }
					spanTo = b
				}
				lines.guideRows(vl, guide.col, add)
				// Block widget rows (under their DOM) as before.
				add(vl.rows, vl.rows + vl.blockRows)
				r = Math.max(r + 1, rowStart + vl.rows + vl.blockRows)
			}
			flushSpan()
		}

		if (gw) {
			pushRect(gutter, 0, -FAR, gw, 2 * FAR, t.gutterBackground)
			pushRect(gutter, gw - 1, -FAR, 1, 2 * FAR, t.gutterBorder)
			this.buildGutterMarkers(rowY)
		}
		if (this.lineNumbers) {
			if (this.relativeNumbers) {
				// Relative numbers change with the cursor: drawn here, not in the scene.
				let cur = doc.lineAt(sel.main.head).number
				for (let n = lines.lineAtRow(first).line, end = lines.lineAtRow(last).line; n <= end;) {
					let vl = lines.vline(n)
					let g = this.gutterRow(n)
					if (!active.has(n) && !vl.cover) this.emitNumber(this.dynGlyphs, Math.abs(g.line - cur), this.gutterRight, rowY(g.row), this.gutterStyle)
					n = vl.last + 1
				}
			}
			for (let n of active.keys()) {
				let {row, line} = this.gutterRow(n)
				if (row < first || row > last) continue
				// Cover the static number, then draw the highlighted one.
				pushRect(gutter, 0, rowY(row), gw, lh, t.gutterBackground)
				if (highlightActive) pushRect(gutter, 0, rowY(row), gw, lh, t.activeLineGutter)
				this.emitNumber(this.dynGlyphs, line, this.gutterRight, rowY(row), highlightActive ? this.gutterActiveStyle : this.gutterStyle)
			}
			this.buildFoldMarkers(active, rowY)
		}
		if (gw) this.buildGutterClasses(rowY)
		this.buildPlaceholder(rowY)
	}

	/// Markers of the extra gutter columns, for the rows in the window.
	private buildGutterMarkers(rowY: (row: number) => number) {
		if (!this.gutterColumns.length) return
		let doc = this.state.doc, lines = this.lines, {first, last} = this.selWindow
		let w = this.gutterColumnWidth, lh = this.lineHeight, dpr = this.dpr
		let from = doc.line(lines.lineAtRow(first).line).from, to = lines.vline(lines.lineAtRow(last).line).to
		let s = Math.max(5, Math.round(Math.min(w, lh) * 0.5 * dpr))
		let overlay = this.overlayMarkers
		let draw = (marker: GutterMarker, col: number, n: number) => {
			if (lines.hidden(n) || lines.covered(n)) return
			let box = overlay ? this.overlayBox(n) : {x: col * w, w}
			let look = this.gutters.look(marker, this), x0 = box.x, y = rowY(this.gutterRow(n).row)
			if (look.shape) {
				let shape = look.shape
				let g = this.atlas.shape(`gm-${shape}-${s}`, shape == "bar" ? Math.max(2, Math.round(dpr * 3)) : s, shape == "bar" ? Math.round(lh * dpr) : s, cx => {
					cx.beginPath()
					if (shape == "dot") cx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2)
					else if (shape == "triangle") { cx.moveTo(s / 2, 0); cx.lineTo(s, s); cx.lineTo(0, s) }
					else cx.rect(0, 0, cx.canvas.width, cx.canvas.height)
					cx.fill()
				})
				let gw = g.w / dpr, gh = g.h / dpr
				pushGlyph(this.dynGlyphs, shape == "bar" ? x0 + 1 : Math.max(0, x0 + (box.w - gw) / 2), y + (lh - gh) / 2, g, look.color ?? this.theme.gutterForeground)
			} else if (look.text) {
				let st = this.styles[this.gutterStyle], cw = this.cellWidth, text = look.text
				let x = Math.max(0, x0 + (box.w - Math.min(text.length, 2) * cw) / 2)
				for (let i = 0; i < text.length && i < 2; i++) {
					let g = text.charCodeAt(i) < 128 ? this.atlas.asciiGlyph(st.variant, text.charCodeAt(i)) : this.atlas.glyph(st.variant, text[i])
					if (g.w) pushGlyph(this.dynGlyphs, x + i * cw + g.ox, y + g.oy, g, look.textColor ?? look.color ?? st.color)
				}
			}
		}
		for (let col = 0; col < (overlay ? 1 : this.markerColumnCount); col++) {
			// In a shared column the first gutter's marker wins on a line.
			let taken = new Set<number>()
			let put = (marker: GutterMarker, n: number) => {
				if (taken.has(n)) return
				taken.add(n)
				draw(marker, col, n)
			}
			for (let config of this.columnConfigs(col)) {
				// Every marker's class applies to its gutter element.
				let mark = (marker: GutterMarker, n: number) => {
					// Overlaid, a marker's gutter element is the whole gutter.
					if (marker.elementClass) this.tintGutter(overlay ? 0 : col * w, overlay ? this.gutterWidth - 1 : w, n, marker.elementClass, config.class)
					put(marker, n)
				}
				for (let set of this.gutters.markerSets(config, this))
					set.between(from, to, (pos, _to, marker) => { mark(marker, doc.lineAt(pos).number) })
				if (this.gutters.hasLineMarker(config)) {
					for (let n = lines.lineAtRow(first).line, end = lines.lineAtRow(last).line; n <= end;) {
						let vl = lines.vline(n), m = config.lineMarker(this, this.lineBlockAt(vl.from), [])
						if (m) mark(m, n)
						n = vl.last + 1
					}
				}
			}
		}
	}

	/// The placeholder text while the document is empty.
	private buildPlaceholder(rowY: (row: number) => number) {
		let text = this.config.placeholder
		if (!text || this.state.doc.length) return
		let st = this.styles[this.gutterStyle], cw = this.cellWidth, clusters = this.layouts.get(text)
		if (!clusters) {
			for (let i = 0; i < text.length; i++) {
				let g = this.atlas.asciiGlyph(st.variant, text.charCodeAt(i))
				if (g.w) pushGlyph(this.placeholderGlyphs, i * cw + g.ox, rowY(0) + g.oy, g, st.color)
			}
		} else {
			for (let c of clusters) {
				if (c.kind == ClusterKind.Tab) continue
				let g = c.kind == ClusterKind.Shaped ? this.atlas.shapedGlyph(st.variant, c.text, c.cells) : this.atlas.glyph(st.variant, c.text)
				if (g.w) pushGlyph(this.placeholderGlyphs, c.col * cw + g.ox, rowY(0) + g.oy, g, st.color)
			}
		}
	}

	/// Fold markers in the gutter's left padding: closed for folded
	/// lines, open for foldable ones (see `foldMarkers`).
	private buildFoldMarkers(_active: Map<number, {row: number}>, rowY: (row: number) => number) {
		let mode = this.config.foldMarkers ?? "fade"
		if (mode == "none") return
		let state = this.state, doc = state.doc, lines = this.lines, {first, last} = this.selWindow
		let dpr = this.dpr, lh = this.lineHeight
		// In the column right of the numbers.
		let pad = this.gutterPad
		// VS Code-style chevrons: thin strokes with round ends, about 0.85
		// of a character wide, pointing down for a fold range and right
		// for a folded one. `s` is the square box (device px) around one.
		let lw = Math.max(1, Math.round(1.3 * dpr))
		let s = Math.round(Math.min(pad - 2, this.cellWidth * 0.85, lh * 0.5) * dpr) + 2 * lw
		let mx = this.gutterRight + (pad - s / dpr) / 2
		let markX = (_n: number) => mx
		let color = this.theme.gutterForeground
		let marker = (open: boolean) => this.atlas.shape(`fold-chevron-${open ? "open" : "closed"}-${s}`, s, s, cx => {
			let arm = (s - 2 * lw) / 2, at = (s - arm) / 2
			cx.lineWidth = lw
			cx.lineCap = cx.lineJoin = "round"
			cx.strokeStyle = cx.fillStyle
			cx.beginPath()
			if (open) { cx.moveTo(lw, at); cx.lineTo(s / 2, at + arm); cx.lineTo(s - lw, at) }
			else { cx.moveTo(at, lw); cx.lineTo(at + arm, s / 2); cx.lineTo(at, s - lw) }
			cx.stroke()
		})
		let now = performance.now(), fading = false
		this.hoverFade.set(this.gutterHover ? 1 : 0, now)
		let hoverAlpha = mode == "always" ? 1 : this.hoverFade.value(now)
		if (!this.hoverFade.settled(now)) fading = true
		// The cursor's marker: fade the new one in, the old ones out.
		let cur = mode == "fade" ? this.cursorFoldLine() : 0
		for (let [n, f] of this.markerFades) {
			if (n != cur) f.set(0, now)
			if (f.to == 0 && f.settled(now)) this.markerFades.delete(n)
		}
		if (cur && !this.markerFades.has(cur)) this.markerFades.set(cur, new Fade())
		this.markerFades.get(cur)?.set(1, now)
		let cursorAlpha = (n: number) => {
			let f = this.markerFades.get(n)
			if (!f) return 0
			if (!f.settled(now)) fading = true
			return f.value(now)
		}
		let folded = foldedRanges(state)
		let seen = new Set<number>()
		if (folded.size) {
			let from = doc.line(lines.lineAtRow(first).line).from, to = lines.vline(lines.lineAtRow(last).line).to
			folded.between(from, to, a => {
				let n = lines.vlineStart(doc.lineAt(a).number)
				if (seen.has(n) || lines.covered(n)) return
				seen.add(n)
				pushGlyph(this.dynGlyphs, markX(n), rowY(this.gutterRow(n).row) + (lh - s / dpr) / 2, marker(false), color)
			})
		}
		let open = (n: number, alpha: number) => {
			if (seen.has(n) || lines.covered(n) || alpha <= 0) return
			seen.add(n)
			let row = this.gutterRow(n).row, tint = fadeColor(color, alpha)
			// A tint whose alpha rounds to 0 would mark a color glyph: the
			// shader would draw the mask itself, a white flash at the end of
			// a fade (quickly hovering and leaving the gutter).
			if (row >= first && row <= last && (tint >>> 24))
				pushGlyph(this.dynGlyphs, markX(n), rowY(row) + (lh - s / dpr) / 2, marker(true), tint)
		}
		if (hoverAlpha > 0) {
			// Every foldable visual line in the window.
			for (let n = lines.lineAtRow(first).line, end = lines.lineAtRow(last).line; n <= end;) {
				let vl = lines.vline(n), line = doc.line(vl.first)
				if (!seen.has(n) && foldable(state, line.from, line.to)) open(n, Math.max(hoverAlpha, cursorAlpha(n)))
				n = vl.last + 1
			}
		}
		for (let n of this.markerFades.keys()) if (n <= doc.lines) open(n, cursorAlpha(n))
		this.foldFading = fading
	}

	/// The first line of the innermost fold range around the cursor
	/// (0 if none), cached until the selection, document or tree change.
	private cursorFoldLine() {
		let state = this.state, key = [state.selection.main.head, state.doc, syntaxTree(state), this.lines.version]
		if (key.every((v, i) => v === this.cursorFold.key[i])) return this.cursorFold.line
		let doc = state.doc, lines = this.lines, head = state.selection.main.head, found = 0
		let cur = lines.vlineStart(doc.lineAt(head).number)
		for (let n = cur, min = Math.max(1, cur - 300); n >= min; n = lines.vlineStart(n - 1)) {
			let line = doc.line(n), range = foldable(state, line.from, line.to)
			if (range && range.to >= head) { found = n; break }
			if (n == 1) break
		}
		this.cursorFold = {key, line: found}
		return found
	}

	/// Teardrop selection handles, drawn as tinted atlas shapes.
	private buildHandles(rowY: (row: number) => number) {
		let buf = this.handleGlyphs, ts = this.touchSelection
		buf.reset()
		let dpr = this.dpr, s = Math.round(ts.handleSize * dpr), r = s / 2
		if (!s) return
		let color = this.theme.selectionHandle
		for (let {kind, pos, side} of ts.handles()) {
			let c = this.posCoords(pos, side)
			let x = c.x * this.cellWidth, y = rowY(c.row) + this.lineHeight
			let g, gx
			if (kind == "cursor") {
				let d = Math.ceil(s * Math.SQRT2)
				g = this.atlas.shape(`handle-cursor-${s}`, d, d, cx => {
					cx.translate(d / 2, 0)
					cx.rotate(Math.PI / 4)
					cx.beginPath()
					cx.roundRect(0, 0, s, s, [0, r, r, r])
					cx.fill()
				})
				gx = x - d / 2 / dpr
			} else {
				let radii = kind == "end" ? [0, r, r, r] : [r, 0, r, r]
				g = this.atlas.shape(`handle-${kind}-${s}`, s, s, cx => {
					cx.beginPath()
					cx.roundRect(0, 0, s, s, radii)
					cx.fill()
				})
				gx = kind == "end" ? x : x - s / dpr
			}
			pushGlyph(buf, gx, y, g, color)
		}
	}

	// ---- Sticky scroll -----------------------------------------------------

	/// How many sticky lines may show (0: off).
	private get stickyMax() {
		let s = this.config.stickyScroll
		if (!s) return 0
		let max = s === true ? 5 : Math.max(0, Math.floor(s.maxLines ?? 5))
		return Math.min(max, Math.floor(this.visibleHeight / this.lineHeight / 3))
	}

	private stickyRows: StickyRows = {
		lineAtRow: row => this.lines.lineAtRow(row).line,
		lastLine: n => this.lines.vline(n).last,
		lastRow: () => this.lines.totalRows - 1
	}

	/// Point the scope finder at the current state and the longest tree
	/// (the syntax driver's runs ahead of the state's for a while).
	private syncScopes() {
		let tree = syntaxTree(this.state), len = tree.length, pub = this.syntax.canonicalTree(this.state.doc)
		if (pub && pub.len > len) { tree = pub.tree; len = pub.len }
		this.scopes.sync(this.state, tree, len, this.tabSize)
	}

	/// Pick the sticky lines for this scroll position (cached per row in
	/// `ScopeFinder.headers`), rebuild their instances when they or their
	/// content changed, and set the last line's push offset. A frame
	/// that scrolls within a row only computes that offset.
	private buildSticky() {
		let st = this.sticky, max = this.stickyMax, lh = this.lineHeight
		let headers: StickyHeaders | null = null
		if (max) {
			this.syncScopes()
			let probe = this.rowAtHeight(this.top + lh - 0.01)
			headers = this.scopes.headers(this.stickyRows, probe, max, this.lines.version)
			st.push = headers.pushed < 0 ? 0 : Math.min(0, this.rowTop(probe + headers.pushed) - (this.top + (headers.pushed + 1) * lh))
		}
		let count = headers ? headers.lines.length : 0
		st.height = count ? count * lh + st.push : 0
		if (!headers) {
			if (st.lines.length) this.emitSticky([])
			st.key = []
			return
		}
		let cur = this.relativeNumbers ? this.state.doc.lineAt(this.state.selection.main.head).number : 0
		let key = [headers.lines, this.state.doc, this.styles, this.atlas, this.atlas.generation, this.atlas.ligatures, this.atlas.ligatureVersion, this.theme, this.metrics, this.gutterWidth,
			this.contentLeft, this.lineNumbers, cur, this.lines.version, this.rainbowState, this.syntax]
		if (sameKey(key, st.key)) {
			// Provisional colors: rebuild when better ones arrive.
			if (!st.exact) for (let i = 0; i < st.lines.length; i++) {
				let runs: LineRuns | null = null
				this.syntax.runsFor(st.lines[i], st.lines[i], (_n, r) => { runs = r }, false)
				if (!sameRuns(runs, st.runs[i])) { st.key = []; break }
			}
			// A long line scrolled out of its emitted columns.
			if (st.long) {
				let {from, to} = this.visibleCols()
				if (from < st.cols.from || to > st.cols.to) st.key = []
			}
			if (st.key.length) return
		}
		st.key = key
		let lines: number[] = []
		for (let n of headers.lines) lines.push(this.lines.vlineStart(n))
		this.emitSticky(lines)
	}

	/// The visible unwrapped columns of the text area.
	private visibleCols() {
		let cw = this.cellWidth
		return {from: Math.floor(this.left / cw), to: Math.ceil((this.left + this.width - this.contentLeft) / cw)}
	}

	private emitSticky(lines: number[]) {
		let st = this.sticky, t = this.theme, lh = this.lineHeight, gw = this.gutterWidth
		for (let p of this.stickyParts) { p.bg.reset(); p.rects.reset(); p.glyphs.reset(); p.nums.reset() }
		st.lines = lines
		st.runs.length = 0
		st.exact = true
		st.long = false
		let vis = this.visibleCols(), span = vis.to - vis.from
		st.cols = {from: Math.max(0, vis.from - span), to: vis.to + span}
		let cur = this.relativeNumbers ? this.state.doc.lineAt(this.state.selection.main.head).number : 0
		for (let i = 0; i < lines.length; i++) {
			let part = this.stickyParts[i == lines.length - 1 ? 0 : 1], y = i * lh
			let vl = this.lines.vline(lines[i])
			pushRect(part.bg, 0, y, FAR, lh, t.stickyBackground)
			if (gw) {
				pushRect(part.bg, 0, y, gw, lh, t.gutterBackground)
				pushRect(part.bg, gw - 1, y, 1, lh, t.gutterBorder)
			}
			let runs: LineRuns | null = null, exact = true
			this.syntax.runsFor(vl.first, vl.first, (_n, r, e) => { runs = r; exact = e }, false)
			st.runs.push(runs)
			if (!exact) st.exact = false
			if (!vl.breaks && vl.width > 512) st.long = true
			this.scene.emitRow(part.glyphs, part.rects, vl, runs, this.rainbowState ? this.lineBrackets(vl.first) : null, y,
				st.cols.from, st.cols.to, this.syntax)
			if (this.lineNumbers) {
				let n = vl.first, shown = cur && n != cur ? Math.abs(n - cur) : n
				this.emitNumber(part.nums, shown, this.gutterRight, y, this.gutterStyle)
			}
		}
		// A soft shadow under the last line, moving with it.
		if (lines.length) {
			let y = lines.length * lh, bg = this.stickyParts[0].bg
			for (let i = 0, alpha = [0.6, 0.32, 0.15, 0.05]; i < alpha.length; i++)
				pushRect(bg, 0, y + i, FAR, 1, fadeColor(t.stickyShadow, alpha[i]))
		}
	}

	/// Room sticky lines take above the line at `pos` when it's scrolled
	/// to just below them (to keep the cursor clear of them).
	private stickyInset(pos: number) {
		let max = this.stickyMax
		if (!max) return 0
		this.syncScopes()
		let n = this.lines.vlineStart(this.state.doc.lineAt(pos).number)
		return Math.min(max, this.scopes.chain(n).length) * this.lineHeight
	}

	/// The sticky line under client coordinates: its slot and line.
	private stickyAt(clientX: number, clientY: number) {
		let st = this.sticky
		if (!st.height || !st.lines.length) return null
		let rect = this.surfaceRect(), y = clientY - rect.top
		if (y < 0 || y >= st.height || clientX < rect.left || clientX > rect.right) return null
		let slot = Math.min(st.lines.length - 1, Math.floor(y / this.lineHeight))
		return {slot, line: st.lines[slot]}
	}

	/// A tap or click on a sticky line scrolls its line to where it's
	/// drawn (the lines above it stay pinned, so nothing moves on screen
	/// but the scope's body) and puts the cursor there.
	private stickyClick(clientX: number, clientY: number, e: Event) {
		let hit = this.stickyAt(clientX, clientY)
		if (!hit) return false
		e.preventDefault()
		let vl = this.lines.vline(hit.line), row = this.lines.rowOf(vl.first)
		let x = Math.max(0, (clientX - this.surfaceRect().left - this.contentLeft + this.left) / this.cellWidth)
		let {pos, side} = this.posAtRow(row, x)
		this.scroller.cancelFling()
		this.scrollTop = this.rowTop(row) - hit.slot * this.lineHeight
		this.dispatch({selection: EditorSelection.cursor(pos, side), userEvent: "select.pointer"})
		this.focus()
		return true
	}

	/// Block widgets' DOM is above the canvas: clip it under the sticky lines.
	private clipBlocks() {
		if (!this.decos.blockCount && !this.blocks.size) return
		let h = Math.max(0, Math.round(this.sticky.height))
		if (h == this.blocksClip) return
		this.blocksClip = h
		this.blocks.dom.style.clipPath = h ? `inset(${h}px 0 0 0)` : ""
	}

	private passList: DrawPass[] = []
	private clips = {content: {x: 0, y: 0, w: 0, h: 0}, gutter: {x: 0, y: 0, w: 0, h: 0}}

	private passes(): DrawPass[] {
		let scene = this.scene, p = this.passList
		let cl = this.contentLeft, gw = this.gutterWidth
		let content = this.clips.content, gutter = this.clips.gutter
		content.x = gw; content.w = this.width - gw; content.h = this.height
		gutter.w = gw; gutter.h = this.height
		let sceneY = this.rowTop(scene.origin) - this.top, textX = cl - this.left
		let i = 0
		let put = (kind: "rect" | "glyph", buffer: InstanceBuffer, offsetX: number, offsetY: number, clip: DrawPass["clip"]) => {
			let pass = p[i] ?? (p[i] = {kind, buffer, first: 0, count: 0, offsetX: 0, offsetY: 0})
			pass.kind = kind
			pass.buffer = buffer
			pass.count = buffer.count
			pass.offsetX = offsetX
			pass.offsetY = offsetY
			pass.clip = clip
			i++
		}
		put("rect", this.underRects, textX, sceneY, content)
		put("rect", scene.rects, textX, sceneY, content)
		put("glyph", scene.glyphs, textX, sceneY, content)
		put("glyph", this.placeholderGlyphs, textX, sceneY, content)
		put("rect", this.overRects, textX, sceneY, content)
		put("rect", this.cursorRects, textX, sceneY, content)
		// Blink and blur hide the cursor without rebuilding anything.
		if (this.focused ? !this.cursorOn : !this.steadyCursor) p[i - 1].count = 0
		if (gw) {
			put("rect", this.gutterRects, 0, sceneY, gutter)
			put("glyph", scene.gutter, 0, sceneY, gutter)
			put("glyph", this.dynGlyphs, 0, sceneY, gutter)
		}
		// Sticky lines over everything but handles and scrollbars: the
		// last one first, so it slides under the others when pushed up.
		if (this.stickyMax) for (let j = 0; j < 2; j++) {
			let part = this.stickyParts[j], y = j == 0 ? this.sticky.push : 0
			put("rect", part.bg, 0, y, null)
			put("rect", part.rects, textX, y, content)
			put("glyph", part.glyphs, textX, y, content)
			put("glyph", part.nums, 0, y, gutter)
		}
		put("glyph", this.handleGlyphs, textX, sceneY, null)
		put("rect", this.vThumb, 0, this.thumbs.vY, null)
		put("rect", this.hThumb, this.thumbs.hX, 0, null)
		p.length = i
		return p
	}

	// ---- Setup / resize -------------------------------------------------------

	private measure() {
		let px = this.measureLineHeight()
		if (px != null) this.font.lineHeight = px / this.font.size
		else if (this.fixedLineHeight != null) this.font.lineHeight = this.fixedLineHeight
		this.metrics = measureFont(this.font, this.dpr, px ?? undefined)
		this.atlas = new GlyphAtlas(this.metrics, this.backend?.maxTextureSize ?? 4096, this.theme.dark ? "#fff" : "#000")
		this.atlas.ligatures = this.config.fontLigatures ?? this.ligatures
		this.layouts?.clear()
		this.lines?.reset()
		this.resetStyles()
		this.schedulePrewarm()
	}

	private prewarmTimer: ReturnType<typeof setTimeout> | null = null

	/// Rasterize printable ASCII in idle slices after an atlas is
	/// created, so the first scroll through a file doesn't pay for it.
	private schedulePrewarm() {
		if (this.prewarmTimer != null) clearTimeout(this.prewarmTimer)
		let atlas = this.atlas
		let step = () => {
			this.prewarmTimer = null
			if (this.destroyed || atlas != this.atlas) return
			if (this.scroller?.active) {
				this.prewarmTimer = setTimeout(step, 100)
				return
			}
			let variants = [...new Set(this.styles.map(s => s.variant))]
			let done = atlas.prewarm(variants.length ? variants : [0], performance.now() + 4)
			this.requestFrame()
			if (!done) this.prewarmTimer = setTimeout(step, 16)
		}
		this.prewarmTimer = setTimeout(step, 50)
	}

	private resetStyles() {
		this.classStyles = []
		this.classDeco = []
		this.variantStyles.clear()
		let t = this.theme
		this.styles = []
		this.defaultStyle = this.addStyle(t.foreground)
		this.gutterStyle = this.addStyle(t.gutterForeground)
		this.gutterActiveStyle = this.addStyle(t.gutterActiveForeground)
		this.decos?.clearStyles()
		this.scene.reset(this.scene.origin)
	}

	setTheme(spec: CanvasThemeSpec) {
		this.theme = new CanvasTheme(spec)
		this.dom.style.background = cssColor(this.theme.background)
		if (!this.highlighters) this.syntax.setHighlighter(this.syntaxHighlighter)
		// Masks are tinted in the shader; only a dark/light switch
		// (mask color) needs a new atlas.
		if ((this.atlas.maskColor == "#fff") != this.theme.dark) this.measure()
		else this.resetStyles()
		this.lines.reset()
		this.requestFrame()
	}

	setFont(font: Partial<FontSpec>) {
		if ("lineHeight" in font) this.fixedLineHeight = font.lineHeight ?? null
		this.font = {...this.font, ...font}
		this.measure()
		this.syncWrapping()
		this.requestFrame()
	}

	/// The line height in CSS pixels, measured on a hidden `.cm-line`
	/// like CodeMirror's, so rows are exactly as tall as the DOM
	/// editor's. Null until the view is laid out.
	private measureLineHeight() {
		let px = this.classReader.lineHeight(this.font, this.fixedLineHeight)
		this.lineHeightUnread = px == null
		return px
	}

	/// Follow a line height change (a theme, the editor connected).
	private syncLineHeight() {
		let key = [this.state.facet(EditorView.styleModule), this.plugins.themeClasses]
		if (!this.lineHeightUnread && sameKey(key, this.lineHeightKey)) return
		this.lineHeightKey = key
		this.syncLigatures()
		let px = this.measureLineHeight()
		if (px == null || px == this.metrics.lineHeight) return
		this.measure()
		this.syncWrapping()
		this.requestFrame()
	}

	private ligatures = true

	/// Follow the `fontLigatures` option or, without one, the editor's
	/// CSS. The scene key includes the atlas's flag, so a change re-emits
	/// the lines.
	private syncLigatures() {
		let on = this.ligatures = this.config.fontLigatures ?? this.classReader.ligatures() ?? this.ligatures
		if (on == this.atlas.ligatures) return
		this.atlas.ligatures = on
		this.requestFrame()
	}

	private onFontsLoaded = () => {
		GlyphAtlas.fontsChanged()
		let before = this.metrics
		let next = measureFont(this.font, this.dpr)
		let lineHeight = this.measureLineHeight()
		if (next.cellWidthDev != before.cellWidthDev || next.advanceDev != before.advanceDev ||
			lineHeight != null && lineHeight != before.lineHeight) {
			this.measure()
			this.syncWrapping()
		} else {
			this.atlas.clear()
		}
		this.requestFrame()
	}

	private watchDPR() {
		this.dprQuery?.removeEventListener("change", this.onDPR)
		this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
		this.dprQuery.addEventListener("change", this.onDPR)
	}

	private onDPR = () => {
		this.dpr = window.devicePixelRatio || 1
		this.measure()
		this.watchDPR()
		this.onResize()
	}

	private onResize() {
		let rect = this.surfaceRect()
		let shrank = rect.height < this.height
		let widthChanged = Math.abs(rect.width - this.width) > 0.5
		this.width = Math.max(1, rect.width)
		this.height = Math.max(1, rect.height)
		let cleared = this.backend?.resize(this.width, this.height, this.dpr) ?? false
		if (widthChanged) this.syncWrapping()
		// The scene doesn't depend on the size (unless wrapping), so
		// resizing (e.g. every frame of a keyboard animation) rebuilds nothing.
		this.scrollTop = this.top
		this.scrollLeft = this.left
		this.updateKeyboardInset(false)
		// A keyboard opening with `resizes-content` shrinks the editor:
		// keep the caret in view, like native editors.
		if (shrank && this.hasFocus) this.scrollPosIntoView(this.state.selection.main.head)
		if (!this.plugins.isUpdating) this.applyUpdate([], 16)
		// Reallocating the canvas cleared it, and ResizeObserver callbacks
		// run after the frame's animation callbacks, right before paint:
		// draw now, or that paint shows an empty canvas (a blink on every
		// keyboard open/close and window resize).
		if (cleared) this.draw(performance.now())
		else this.requestFrame()
	}

	/// Track an on-screen keyboard that overlays the editor (the default
	/// on Android Chrome, `interactive-widget=resizes-visual`, and on
	/// iOS): the covered bottom becomes extra scroll room, and the caret
	/// is kept above the keyboard.
	private updateKeyboardInset(keepCaret = true) {
		let vv = window.visualViewport
		let inset = 0
		if (vv) {
			let rect = this.surfaceRect()
			let visibleBottom = vv.offsetTop + vv.height
			inset = Math.max(0, Math.min(rect.height - this.lineHeight * 2, rect.bottom - visibleBottom))
		}
		if (Math.abs(inset - this.bottomInset) < 0.5) return
		let grew = inset > this.bottomInset
		this.bottomInset = inset
		this.scrollTop = this.top
		if (grew && keepCaret && this.hasFocus) this.scrollPosIntoView(this.state.selection.main.head)
		this.requestFrame()
	}

	private onViewportChange = () => this.updateKeyboardInset()

	private maxColsJob = 0

	/// The widest line (for the horizontal scroll range). Only the start
	/// is scanned before the first frame; the rest of a big document in
	/// idle slices, since nothing else waits for it.
	private computeMaxCols() {
		let job = ++this.maxColsJob, iter = this.state.doc.iterLines(), tab = this.tabSize, max = 0
		let scan = (deadline: number) => {
			for (let n = 0;; n++) {
				if ((n & 255) == 0 && performance.now() > deadline) return false
				if (iter.next().done) return true
				let text = iter.value
				if (text.length * 2 > max) max = Math.max(max, approxCols(text, tab))
			}
		}
		let done = scan(performance.now() + 2)
		this.maxCols = max
		if (done) return
		let next = () => {
			if (job != this.maxColsJob || this.destroyed) return
			if (this.interacting) { setTimeout(next, 150); return }
			let finished = scan(performance.now() + 4)
			if (max > this.maxCols) {
				this.maxCols = max
				this.requestFrame()
			}
			if (!finished) setTimeout(next, 16)
		}
		setTimeout(next, 50)
	}

	/// Debug information about parsing and the current scene.
	get debug() {
		let {first, last} = this.visibleRows()
		return {backend: this.backend?.kind, syntax: this.syntax.progress, origin: this.scene.origin,
			coverage: this.scene.coverage(first, last), rows: this.lines.totalRows, wrap: this.lines.wrap,
			atlasSize: this.atlas.size, glyphs: this.scene.glyphs.count, rects: this.scene.rects.count, gutter: this.scene.gutter.count}
	}

	destroy() {
		this.destroyed = true
		this.magnifier?.destroy()
		if (this.prewarmTimer != null) clearTimeout(this.prewarmTimer)
		if (this.probeTimer) clearTimeout(this.probeTimer)
		if (this.blinkTimer != null) clearTimeout(this.blinkTimer)
		if (this.idleTimer != null) clearTimeout(this.idleTimer)
		if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
		if (this.gutterClassTimer != null) clearTimeout(this.gutterClassTimer)
		this.plugins.destroy()
		this.classReader.destroy()
		this.decos.destroy()
		this.input.destroy()
		this.scroller.destroy()
		this.syntax.destroy()
		this.resizeObserver.disconnect()
		window.visualViewport?.removeEventListener("resize", this.onViewportChange)
		window.visualViewport?.removeEventListener("scroll", this.onViewportChange)
		this.dprQuery?.removeEventListener("change", this.onDPR)
		document.fonts?.removeEventListener?.("loadingdone", this.onFontsLoaded)
		this.scrollDOM.removeEventListener("pointerdown", this.onPointerDownFirst, true)
		this.scrollDOM.removeEventListener("pointerdown", this.onMouseDown)
		this.scrollDOM.removeEventListener("mousedown", this.preventFocusLoss)
		this.scrollDOM.removeEventListener("contextmenu", this.preventContextMenu)
		this.scrollDOM.removeEventListener("pointermove", this.onPointerHover)
		this.scrollDOM.removeEventListener("pointerleave", this.onPointerHover)
		if (this.treeSyncTimer != null) clearTimeout(this.treeSyncTimer)
		this.viewportChannel?.port1.close()
		this.touchSelection.destroy()
		this.mouseSelection?.destroy()
		this.dragDrop.destroy()
		this.blocks.destroy()
		this.backend?.destroy()
		this.dom.remove()
	}
}

function stickyPart() {
	return {bg: new InstanceBuffer(RECT_STRIDE, 16), rects: new InstanceBuffer(RECT_STRIDE, 16),
		glyphs: new InstanceBuffer(GLYPH_STRIDE, 256), nums: new InstanceBuffer(GLYPH_STRIDE, 16)}
}

function createCanvas() {
	let canvas = document.createElement("canvas")
	Object.assign(canvas.style, {position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "block"})
	return canvas
}

/// Upper estimate of a line's width in cells (tabs at full width,
/// non-ASCII as two cells), without laying it out.
const nonAscii = /[^\x00-\x7f]/

function approxCols(text: string, tabSize: number) {
	let cols = text.length
	if (!nonAscii.test(text)) {
		for (let i = text.indexOf("\t"); i >= 0; i = text.indexOf("\t", i + 1)) cols += tabSize - 1
		return cols
	}
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i)
		if (c == 9) cols += tabSize - 1
		else if (c >= 0x1100 && (c < 0xd800 || c > 0xdfff)) cols++
	}
	return cols
}

function cssColor(c: PackedColor) {
	return `rgba(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255},${(c >>> 24) / 255})`
}

/// The effect type behind CodeMirror's `EditorView.scrollIntoView`,
/// so commands that scroll (page up/down...) work here too.
const scrollIntoViewType: StateEffectType<any> = (EditorView.scrollIntoView(0) as any).type

// Code holding a canvas view's DOM finds it through CodeMirror's own
// `EditorView.findFromDOM`.
const cmFindFromDOM = EditorView.findFromDOM
EditorView.findFromDOM = function(dom: HTMLElement) {
	return cmFindFromDOM.call(this, dom) ?? CanvasView.findFromDOM(dom) as unknown as EditorView | null
}

// A CanvasView stands in for an EditorView, and @codemirror/commands
// checks `target instanceof EditorView` before deletions honor atomic
// ranges (deleteBy's `skipAtomic`). Only EditorView itself is patched,
// so subclasses keep the plain prototype check.
const plainInstanceOf = Function.prototype[Symbol.hasInstance]
Object.defineProperty(EditorView, Symbol.hasInstance, {
	configurable: true,
	value(this: Function, value: unknown) {
		return this === EditorView && value instanceof CanvasView || plainInstanceOf.call(this, value)
	}
})

export type {VLine}

function sameKey(a: readonly unknown[], b: readonly unknown[]) {
	return a.length == b.length && a.every((v, i) => v === b[i])
}

const FOLD_FADE_MS = 120

/// An opacity easing toward 0 or 1 over `FOLD_FADE_MS`.
class Fade {
	from = 0
	to = 0
	start = -1e9

	value(now: number) {
		let t = Math.min(1, (now - this.start) / FOLD_FADE_MS)
		return this.from + (this.to - this.from) * t * t * (3 - 2 * t)
	}

	set(to: number, now: number) {
		if (to == this.to) return
		this.from = this.value(now)
		this.to = to
		this.start = now
	}

	settled(now: number) { return now - this.start >= FOLD_FADE_MS }
}

function fadeColor(color: PackedColor, alpha: number): PackedColor {
	if (alpha >= 1) return color
	return ((Math.round((color >>> 24) * alpha) << 24) | (color & 0xffffff)) >>> 0
}
