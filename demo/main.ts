import {autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap} from "@codemirror/autocomplete"
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands"
import {html} from "@codemirror/lang-html"
import {javascript} from "@codemirror/lang-javascript"
import {bracketMatching, codeFolding, foldable, foldKeymap, highlightingFor, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree} from "@codemirror/language"
import {classHighlighter, tags} from "@lezer/highlight"
import {type Diagnostic, linter, lintGutter, lintKeymap, setDiagnostics} from "@codemirror/lint"
import {closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap} from "@codemirror/search"
import {EditorState, type Extension, type Range, RangeSet, RangeSetBuilder, StateEffect, StateField} from "@codemirror/state"
import {crosshairCursor, Decoration, type DecorationSet, dropCursor, EditorView, gutter, gutterLineClass, GutterMarker, highlightWhitespace,
	hoverTooltip, keymap, lineNumberMarkers, MatchDecorator, rectangularSelection, ViewPlugin, type ViewUpdate,
	WidgetType} from "@codemirror/view"
import {CanvasView, darkTheme, lightTheme} from "../src/index"
import {type FixtureKind, makeFixture} from "./fixtures"
import {guideOption, mountSettings, readOnlyCompartment, setting, stickyOption, whitespaceOption} from "./settings"

let params = new URLSearchParams(location.search)
let get = (key: string) => setting(params, key)!
let kind = get("kind") as FixtureKind
let lines = +get("lines")
let backend = get("backend") as "webgl2" | "webgpu"
let input = get("input") as "auto" | "editcontext" | "textarea"
if (params.has("bare")) document.body.classList.add("bare")
// "full": CodeMirror's view-level packages (search panel, autocomplete,
// lint, hover tooltips, folding, bracket matching, a sample inlay-hint
// plugin), hosted unchanged. "basic": state-level extensions only.
let ext = params.get("ext") ?? (params.has("bare") ? "basic" : "full")
let wrap = get("wrap") == "1"
let light = get("theme") == "light"
if (light) document.body.classList.add("light")

/// A stand-in for LSP inlay hints: a type label after declared names.
class HintWidget extends WidgetType {
	constructor(readonly text: string) { super() }
	override eq(other: HintWidget) { return other.text == this.text }
	toDOM() {
		let el = document.createElement("span")
		el.className = "cm-inlay-hint cm-inlay-hint-pl"
		el.textContent = this.text
		return el
	}
}
const hints = new MatchDecorator({
	regexp: /\b(?:const|let) (\w+)(?= = )/g,
	decorate: (add, _from, to, match) => add(to, to, Decoration.widget({widget: new HintWidget(match[1].length > 5 ? ": object" : ": number"), side: 1}))
})
const inlayHints = ViewPlugin.fromClass(class {
	decorations
	constructor(view: EditorView) { this.decorations = hints.createDeco(view) }
	update(u: ViewUpdate) { this.decorations = hints.updateDeco(u, this.decorations) }
}, {decorations: v => v.decorations})

/// Acode's color chip widget (DOM, sized in em): drawn as a swatch.
class ColorChip extends WidgetType {
	constructor(readonly color: string) { super() }
	override eq(other: ColorChip) { return other.color == this.color }
	toDOM() {
		let el = document.createElement("span")
		el.className = "cm-color-chip"
		Object.assign(el.style, {display: "inline-block", width: "0.9em", height: "0.9em", borderRadius: "2px",
			margin: "0 2px", border: "1px solid rgba(0,0,0,0.2)", backgroundColor: this.color})
		return el
	}
}
/// A widget drawn on the canvas itself (`toCanvas` with `draw`).
class SizeBar extends WidgetType {
	constructor(readonly size: number) { super() }
	override eq(other: SizeBar) { return other.size == this.size }
	toDOM() { return document.createElement("span") }
	toCanvas() {
		let size = this.size
		return {text: "", cells: 3, padLeft: 0.5, key: "bar" + size, draw: (cx: OffscreenCanvasRenderingContext2D, w: number, h: number) => {
			cx.fillStyle = "rgba(97,175,239,0.25)"
			cx.fillRect(0, h * 0.3, w, h * 0.4)
			cx.fillStyle = "#61afef"
			cx.fillRect(0, h * 0.3, w * Math.min(1, size / 47), h * 0.4)
		}}
	}
}
// Both annotate the text before them, so both are `side: -1`: a cursor
// at their position is drawn after them, and they move with that text.
// (Inlay hints are `side: 1`: a cursor at the end of the name stays
// before the hint.)
const chips = new MatchDecorator({
	regexp: /#[0-9a-f]{6}\b|size: (\d+)/gi,
	decorate: (add, from, to, m) => m[1] != null
		? add(to, to, Decoration.widget({widget: new SizeBar(+m[1]), side: -1}))
		: add(from, from, Decoration.widget({widget: new ColorChip(m[0]), side: -1}))
})
const colorChips = ViewPlugin.fromClass(class {
	decorations
	constructor(view: EditorView) { this.decorations = chips.createDeco(view) }
	update(u: ViewUpdate) { this.decorations = chips.updateDeco(u, this.decorations) }
}, {decorations: v => v.decorations})

/// A code-lens style block widget (real DOM in rows of its own) above
/// each exported function. Block decorations come from a state field.
class Lens extends WidgetType {
	constructor(readonly name: string) { super() }
	override eq(other: Lens) { return other.name == this.name }
	toDOM() {
		let el = document.createElement("div")
		el.className = "demo-lens"
		el.style.cssText = "font: 11px system-ui, sans-serif; color: #7d8799; padding: 3px 0; display: flex; gap: 12px; align-items: center"
		let refs = document.createElement("span")
		refs.textContent = `${(this.name.length * 7) % 9 + 1} references`
		let run = document.createElement("button")
		run.textContent = "▶ Run " + this.name
		run.style.cssText = "font: inherit; color: #61afef; background: none; border: 0; padding: 0; cursor: pointer"
		run.onclick = () => { run.textContent = "✓ Ran " + this.name }
		el.append(refs, run)
		return el
	}
	override ignoreEvent() { return true }
}
const lensPattern = /^export (?:async )?function (\w+)/
function lensesIn(state: EditorState, from: number, to: number, add: (pos: number, name: string) => void) {
	for (let pos = from; pos <= to;) {
		let line = state.doc.lineAt(pos), m = lensPattern.exec(line.text)
		if (m) add(line.from, m[1])
		pos = line.to + 1
	}
}
const lenses = StateField.define<DecorationSet>({
	create(state) {
		let b = new RangeSetBuilder<Decoration>()
		lensesIn(state, 0, state.doc.length, (pos, name) => b.add(pos, pos, Decoration.widget({widget: new Lens(name), block: true, side: -1})))
		return b.finish()
	},
	update(set, tr) {
		if (!tr.docChanged) return set
		set = set.map(tr.changes)
		tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
			let from = tr.state.doc.lineAt(fromB).from, to = tr.state.doc.lineAt(toB).to
			let add: any[] = []
			lensesIn(tr.state, from, to, (pos, name) => add.push(Decoration.widget({widget: new Lens(name), block: true, side: -1}).range(pos)))
			set = set.update({filter: f => f < from || f > to, filterFrom: from, filterTo: to, add})
		})
		return set
	},
	provide: f => EditorView.decorations.from(f)
})

/// Collapsed lines, like @codemirror/merge's `collapseUnchanged`: a
/// block replace over whole lines (the internals of every other
/// `Widget` class), drawn as a bar that expands when tapped.
const expandCollapsed = StateEffect.define<string>()
class Collapsed extends WidgetType {
	constructor(readonly name: string, readonly lines: number) { super() }
	override eq(other: Collapsed) { return other.name == this.name && other.lines == this.lines }
	override get estimatedHeight() { return 18 }
	toDOM(view: EditorView) {
		let el = document.createElement("div")
		el.className = "demo-collapsed"
		el.style.cssText = "font: 12px system-ui, sans-serif; color: #7d8799; background: rgba(125, 135, 153, 0.12); padding: 1px 8px; line-height: 16px; cursor: pointer; border-radius: 3px"
		el.textContent = `⋯ ${this.lines} lines collapsed`
		el.title = `${this.name} internals: tap to expand`
		el.onclick = () => view.dispatch({effects: expandCollapsed.of(this.name)})
		return el
	}
	override ignoreEvent() { return true }
}
function collapsedRanges(state: EditorState) {
	let b = new RangeSetBuilder<Decoration>(), doc = state.doc
	for (let n = 1; n <= doc.lines; n++) {
		let m = /^class (Widget(\d+)) /.exec(doc.line(n).text)
		if (!m || +m[2] % 2 == 0) continue
		let end = n + 1
		while (end < doc.lines && doc.line(end + 1).text != "}") end++
		if (end <= n + 1) continue
		b.add(doc.line(n + 1).from, doc.line(end).to,
			Decoration.replace({widget: new Collapsed(m[1], end - n), block: true}))
		n = end
	}
	return b.finish()
}
const collapsed = StateField.define<DecorationSet>({
	create: collapsedRanges,
	update(set, tr) {
		set = set.map(tr.changes)
		for (let e of tr.effects) if (e.is(expandCollapsed))
			set = set.update({filter: (_f, _t, d) => (d.spec.widget as Collapsed).name != e.value})
		return set
	},
	provide: f => EditorView.decorations.from(f)
})

/// A file header block widget before line 1 (drawn above it).
class FileHeader extends WidgetType {
	override eq() { return true }
	toDOM() {
		let el = document.createElement("div")
		el.className = "demo-file-header"
		el.style.cssText = "font: 11px system-ui, sans-serif; color: #7d8799; padding: 4px 0; border-bottom: 1px solid rgba(125, 135, 153, 0.25)"
		el.textContent = "demo file · block widget before line 1"
		return el
	}
	override ignoreEvent() { return true }
}
const fileHeader = EditorView.decorations.of(Decoration.set([Decoration.widget({widget: new FileHeader(), block: true, side: -1}).range(0)]))

const demoLinter = linter(view => {
	let out: Diagnostic[] = []
	let {from, to} = view.viewport
	let text = view.state.sliceDoc(from, to)
	for (let m of text.matchAll(/console\.warn|throw error/g)) {
		let start = from + m.index!
		out.push({from: start, to: start + m[0].length, severity: m[0][0] == "c" ? "warning" : "error",
			message: m[0][0] == "c" ? "Avoid console output in library code" : "Rethrowing loses context"})
	}
	return out
}, {delay: 300})

const wordHover = hoverTooltip((view, pos) => {
	let word = view.state.wordAt(pos)
	if (!word) return null
	return {pos: word.from, end: word.to, above: true, create() {
		let dom = document.createElement("div")
		dom.style.padding = "2px 6px"
		dom.textContent = `${view.state.sliceDoc(word.from, word.to)} (${word.to - word.from} chars)`
		return {dom}
	}}
})

// CodeMirror's breakpoint gutter example, unchanged (not part of
// CodeMirror's defaults, so opt-in: the "Breakpoint gutter" setting): tap
// the column left of the line numbers to toggle a breakpoint.
const breakpointEffect = StateEffect.define<{pos: number, on: boolean}>({
	map: (val, mapping) => ({pos: mapping.mapPos(val.pos), on: val.on})
})
const breakpointState = StateField.define<RangeSet<GutterMarker>>({
	create: () => RangeSet.empty,
	update(set, tr) {
		set = set.map(tr.changes)
		for (let e of tr.effects) if (e.is(breakpointEffect)) {
			if (e.value.on) set = set.update({add: [breakpointMarker.range(e.value.pos)]})
			else set = set.update({filter: from => from != e.value.pos})
		}
		return set
	}
})
const breakpointMarker = new class extends GutterMarker {
	override toDOM() {
		let el = document.createElement("span")
		el.textContent = "●"
		el.style.color = "#e5484d"
		return el
	}
}
// Breakpoint lines tint the whole gutter, through CodeMirror's
// `gutterLineClass` and a theme rule.
const breakpointLine = new class extends GutterMarker { override elementClass = "demo-breakpoint-line" }
const breakpointLines = gutterLineClass.compute([breakpointState], state => {
	let lines: Range<GutterMarker>[] = []
	state.field(breakpointState).between(0, state.doc.length, from => { lines.push(breakpointLine.range(from)) })
	return RangeSet.of(lines)
})
const breakpointTheme = EditorView.theme({".demo-breakpoint-line": {backgroundColor: "rgba(229, 72, 77, 0.22)"}})
const breakpoints = [breakpointState, breakpointLines, breakpointTheme, gutter({
	class: "cm-breakpoint-gutter",
	markers: v => v.state.field(breakpointState),
	initialSpacer: () => breakpointMarker,
	domEventHandlers: {
		mousedown(view, line) {
			let has = false
			view.state.field(breakpointState).between(line.from, line.from, () => { has = true })
			view.dispatch({effects: breakpointEffect.of({pos: line.from, on: !has})})
			return true
		}
	}
})]

let full: Extension = ext == "full" ? [
	codeFolding(), bracketMatching(), highlightSelectionMatches(), search({top: true}),
	autocompletion({override: [completeAnyWord]}), demoLinter, lintGutter(), get("breakpoints") == "1" ? breakpoints : [], wordHover, inlayHints, colorChips, lenses, fileHeader, collapsed,
	rectangularSelection(), crosshairCursor(), dropCursor(),
	light ? [] : EditorView.theme({}, {dark: true}),
	keymap.of([...completionKeymap, ...searchKeymap, ...foldKeymap, ...lintKeymap])
] : []

let t0 = performance.now()
let doc = kind == ("empty" as FixtureKind) ? "" : makeFixture(kind, lines)
// Stock CodeMirror state-level extensions, unchanged.
let state = EditorState.create({doc, extensions: [
	EditorState.tabSize.of(+get("tabSize")),
	EditorState.allowMultipleSelections.of(true),
	readOnlyCompartment.of(EditorState.readOnly.of(get("readOnly") == "1")),
	kind == "html" ? html() : javascript(),
	history(),
	closeBrackets(),
	indentOnInput(),
	full,
	wrap ? EditorView.lineWrapping : [],
	keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab])
]})
// The library has no selection menu; this is a consumer's menu,
// driven by the touch selection hooks.
let menu = document.createElement("div")
menu.id = "menu"
document.body.appendChild(menu)
let clipboard = ""
let writeClipboard = (text: string) => {
	clipboard = text
	navigator.clipboard?.writeText(text).catch(() => {})
}
let readClipboard = async () => {
	try { return (await navigator.clipboard?.readText()) ?? clipboard } catch { return clipboard }
}
let selectedText = () => {
	let s = view.state, r = s.selection.main
	return s.sliceDoc(r.from, r.to)
}
let menuItems = (trigger: "cursor" | "selection", readOnly: boolean) => [
	trigger == "selection" && {label: "Copy", run: () => writeClipboard(selectedText())},
	trigger == "selection" && !readOnly && {label: "Cut", run: () => {
		writeClipboard(selectedText())
		view.dispatch({...view.state.replaceSelection(""), userEvent: "delete.cut"})
	}},
	!readOnly && {label: "Paste", run: async () => {
		let text = await readClipboard()
		if (text) view.dispatch({...view.state.replaceSelection(text), userEvent: "input.paste", scrollIntoView: true})
	}},
	{label: "Select all", run: () => {
		view.dispatch({selection: {anchor: 0, head: view.state.doc.length}})
		view.touchSelection.openMenu()
	}}
].filter(Boolean) as {label: string, run: () => void}[]

let viewStart = performance.now()
let view = new CanvasView({
	parent: document.getElementById("editor")!, state, backend, input,
	theme: light ? lightTheme : darkTheme,
	font: {size: +get("fontSize"), lineHeight: +get("lineHeight")},
	lineNumbers: get("lineNumbers") == "relative" ? "relative" : get("lineNumbers") == "1",
	highlightActiveLine: get("activeLine") == "1",
	gutterMarkers: get("markers") as any,
	rainbowBrackets: get("rainbow") == "1",
	showWhitespace: whitespaceOption(get("whitespace")),
	cursorWidth: +get("cursorWidth"),
	placeholder: "Start typing… (this is the placeholder option)",
	wrapIndent: /^\d+$/.test(get("wrapIndent")) ? +get("wrapIndent") : get("wrapIndent") as any,
	textDirection: get("dir") as any,
	foldMarkers: get("foldMarkers") as any,
	indentGuides: guideOption(get("guides")),
	// Off on bare pages (tests, benchmarks) unless asked for.
	stickyScroll: stickyOption(params.get("sticky") ?? (params.has("bare") ? "0" : get("sticky"))),
	scrollSpeed: get("scrollSpeed") as any,
	scrollPastEnd: +get("pastEnd"),
	horizontalScrollPastEnd: +get("hPastEnd"),
	cursorBlinkRate: +get("blink"),
	touchSelection: {
		handleSize: +get("handles"),
		onHaptic: () => navigator.vibrate?.(20),
		onMenu: e => {
			if (e.type == "hide") {
				menu.style.display = "none"
				return
			}
			menu.textContent = ""
			for (let item of menuItems(e.trigger, e.readOnly)) {
				let b = document.createElement("button")
				b.textContent = item.label
				// Keep focus (and the keyboard) in the editor.
				b.onpointerdown = ev => ev.preventDefault()
				b.onclick = () => {
					menu.style.display = "none"
					item.run()
				}
				menu.appendChild(b)
			}
			menu.style.display = "flex"
			let anchor = e.handleRect ?? e.selectionRect
			let w = menu.offsetWidth, h = menu.offsetHeight
			let left = Math.max(4, Math.min(innerWidth - w - 4, anchor.left + anchor.width / 2 - w / 2))
			let top = e.selectionRect.top - h - 8
			if (top < 4) top = anchor.bottom + 8
			menu.style.left = left + "px"
			menu.style.top = top + "px"
		}
	}
})
let created = performance.now() - t0

declare global {
	interface Window { view: CanvasView, ready: boolean, createMs: number, viewStart: number, cmApi: unknown }
}
window.view = view
// For tests: CodeMirror functions to call against the view.
window.cmApi = {openSearchPanel, closeSearchPanel, syntaxTree, foldable, EditorView, ViewPlugin, StateEffect, StateField, Decoration, WidgetType,
	gutter, GutterMarker, gutterLineClass, lineNumberMarkers, RangeSet,
	highlightWhitespace, breakpointState, HighlightStyle, syntaxHighlighting, highlightingFor, classHighlighter, tags, EditorState, javascript,
	readOnlyCompartment, setDiagnostics}
window.createMs = created
window.viewStart = viewStart
let waitBackend = () => view.backend ? (window.ready = true) : requestAnimationFrame(waitBackend)
waitBackend()

document.getElementById("fling")!.onclick = () => view.fling(0, 6000)
mountSettings(view, params)

let statsEl = document.getElementById("stats")!
if (!params.has("bare")) view.recordStats = true
if (!params.has("bare")) setInterval(() => {
	let s = view.stats.splice(0)
	let work = s.map(f => f.work).sort((a, b) => a - b)
	let p95 = work.length ? work[Math.floor(work.length * 0.95)] : 0
	let d = view.debug
	statsEl.textContent = `${d.backend} frames ${s.length}/s  work p95 ${p95.toFixed(2)}ms  parsed ${(d.syntax.treeLen / d.syntax.docLength * 100).toFixed(0)}%  create ${created.toFixed(0)}ms`
}, 1000)
