import {type ChangeDesc, ChangeSet, RangeSet, type Text} from "@codemirror/state"
import {type Decoration, type DecorationSet, EditorView, type WidgetType} from "@codemirror/view"
import {type PackedColor, parseColor} from "../core/color"
import {domViews} from "./compat"

/// How a mark decoration (or a widget label) is drawn. Set it on a
/// decoration spec as `canvas` (`Decoration.mark({canvas: {...}})`), or
/// map a CSS class to it in the theme's `classes`; CodeMirror's own
/// classes (search matches, lint ranges, matching brackets, fold
/// placeholders...) have built-in defaults.
export interface MarkStyle {
	color?: string
	background?: string
	/// Rounded corners for boxes (widgets drawn as swatches/chips).
	rounded?: boolean
	underline?: "solid" | "wavy"
	underlineColor?: string
	strike?: boolean
	bold?: boolean
	italic?: boolean
	/// Outline color (drawn as a 1px box, e.g. fold placeholders).
	border?: string
}

export interface ResolvedMark {
	color: PackedColor | null
	background: PackedColor | null
	/// 0 none, 1 solid, 2 wavy.
	underline: number
	underlineColor: PackedColor | null
	strike: boolean
	bold: boolean | null
	italic: boolean | null
	border: PackedColor | null
	rounded: boolean
}

/// What a widget draws: a text label in a style. Widgets can provide
/// it directly with a `toCanvas(view)` method; otherwise the label is
/// the `textContent` of `toDOM()` (called once per widget), styled by
/// its classes.
export interface CanvasWidgetSpec {
	text: string
	style?: MarkStyle
	/// Extra space before/after the label, in cells.
	padLeft?: number
	padRight?: number
	/// Width in cells when the widget isn't text (a box, swatch or image).
	cells?: number
	/// Draw the widget yourself, in full color, into a `width`×`height`
	/// device-pixel image (its cells × the line height). Cached by `key`
	/// (default: per widget instance), so give equal drawings equal keys.
	draw?: (cx: OffscreenCanvasRenderingContext2D, width: number, height: number) => void
	key?: string
	/// A zero-width mark at the widget's position, in this color: a
	/// small triangle at the bottom of the line, like CodeMirror's lint
	/// points (`cm-lintPoint` widgets get one from their classes, whose
	/// `underlineColor` the theme's `classes` can set).
	point?: string
}

const lightDefaults: Record<string, MarkStyle> = {
	"cm-searchMatch": {background: "rgba(255,255,0,0.33)"},
	"cm-searchMatch-selected": {background: "rgba(255,106,0,0.33)"},
	"cm-selectionMatch": {background: "rgba(153,255,119,0.5)"},
	"cm-matchingBracket": {background: "rgba(50,140,130,0.32)"},
	"cm-nonmatchingBracket": {background: "rgba(187,85,85,0.27)"},
	"cm-lintRange-error": {underline: "wavy", underlineColor: "#d11"},
	"cm-lintRange-warning": {underline: "wavy", underlineColor: "orange"},
	"cm-lintRange-info": {underline: "wavy", underlineColor: "#999"},
	"cm-lintRange-hint": {underline: "wavy", underlineColor: "#66d"},
	"cm-lintRange-active": {background: "rgba(255,221,153,0.5)"},
	"cm-lintPoint": {underlineColor: "#d11"},
	"cm-lintPoint-warning": {underlineColor: "orange"},
	"cm-lintPoint-info": {underlineColor: "#999"},
	"cm-lintPoint-hint": {underlineColor: "#66d"},
	"cm-foldPlaceholder": {background: "#eee", border: "#ddd", color: "#888"},
	"cm-inlay-hint": {color: "#888", background: "rgba(0,0,0,0.05)"},
	"cm-snippetField": {background: "rgba(0,0,0,0.13)"},
	"cm-specialChar": {color: "#d44"},
	"cm-trailingSpace": {background: "#ff9696"}
}

const darkDefaults: Record<string, MarkStyle> = {
	...lightDefaults,
	"cm-searchMatch": {background: "rgba(114,161,255,0.35)"},
	"cm-searchMatch-selected": {background: "rgba(97,153,255,0.6)"},
	"cm-selectionMatch": {background: "rgba(170,254,102,0.1)"},
	"cm-matchingBracket": {background: "rgba(186,208,248,0.28)"},
	"cm-foldPlaceholder": {background: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.2)", color: "#999"},
	"cm-inlay-hint": {color: "#7d8799", background: "rgba(255,255,255,0.06)"},
	"cm-snippetField": {background: "rgba(255,255,255,0.13)"}
}

/// Classes drawn by the view itself (or meaningless on a canvas).
const ignoredClasses = new Set(["cm-activeLine", "cm-activeLineGutter", "cm-line"])

/// A point decoration that affects layout (inline widget or replaced range).
export interface PointDeco {
	from: number
	to: number
	deco: Decoration
	/// Widget side (-1 before the position, 1 after) for zero-length widgets.
	side: number
	/// The replaced range spans a line break (joins lines).
	joins: boolean
	/// A block widget (drawn in rows of its own between lines).
	block: boolean
	/// A block replace (`Decoration.replace({block: true})`). Covering
	/// whole lines, it's drawn as a block of its own (see
	/// `VLine.cover`); otherwise like an inline replace.
	blockReplace: boolean
}

/// Collects `EditorView.decorations`, keeps the layout-affecting
/// points (widgets, replaced ranges) in a sorted list, and reports what
/// changed between updates.
export class DecoState {
	sets: readonly DecorationSet[] = []
	/// How many points are block widgets or block replaces.
	blockCount = 0
	/// How many points are block replaces.
	coverCount = 0
	points: PointDeco[] = []
	/// Replaced ranges crossing line breaks, sorted, as [from, to] pairs.
	joins: number[] = []
	private styleCache = new WeakMap<Decoration, ResolvedMark | null>()
	private decoIds = new WeakMap<Decoration, number>()
	private single = new WeakMap<Decoration, number>()
	private nextId = 1
	private combos = new Map<string, number>()
	/// Resolved mark styles; mark run ids index into it.
	marks: ResolvedMark[] = []
	private widgetSpecs = new WeakMap<WidgetType, CanvasWidgetSpec>()
	/// DOM elements created for widget labels → their widget, so
	/// `posAtDOM` and click forwarding work for DOM-based widgets.
	readonly widgetDOM = new WeakMap<HTMLElement, WidgetType>()

	/// Called with the document ranges of widgets whose label changed
	/// (their DOM changed in place), as flat [from, to] pairs.
	onWidgetChange: (ranges: number[]) => void = () => {}
	/// Watches widgets' DOM, which is live like in CodeMirror: a label
	/// is read again when its element changes.
	private observer = typeof MutationObserver == "undefined" ? null : new MutationObserver(recs => this.domChanged(recs))
	private view: EditorView | null = null

	constructor(private classStyle: (cls: string) => MarkStyle | null, private dark: () => boolean) {}

	get empty() { return this.sets.length == 0 }

	/// Read the decoration facet. Returns the document ranges whose
	/// marks changed and those whose layout (points) changed, both in
	/// new-document positions, or null when nothing changed.
	update(view: EditorView, doc: Text, changes: ChangeDesc | null) {
		let next: DecorationSet[] = []
		for (let source of view.state.facet(EditorView.decorations))
			next.push(typeof source == "function" ? source(view) : source)
		for (let source of view.state.facet(EditorView.outerDecorations))
			next.push(typeof source == "function" ? source(view) : source)
		next = next.filter(s => s.size > 0)
		let prev = this.sets
		if (!changes && next.length == prev.length && next.every((s, i) => s === prev[i])) return null
		let marks: number[] = [], points: number[] = []
		RangeSet.compare(prev, next, changes ?? ChangeSet.empty(doc.length), {
			compareRange(from, to) { addRange(marks, from, to) },
			comparePoint(from, to) { addRange(points, from, to) }
		})
		this.sets = next
		this.view = view
		if (changes || points.length) this.rebuildPoints(doc, changes, points)
		return {marks, points}
	}

	private rebuildPoints(doc: Text, changes: ChangeDesc | null, changed: number[]) {
		// Map known points in place (they stay sorted) and drop those in
		// changed ranges; re-collect those ranges, sort just the few new
		// points, and merge. Linear in the number of points, no copies:
		// documents can have thousands (inlay hints, code lenses).
		let kept: PointDeco[] = [], dropped: PointDeco[] = []
		if (changes || changed.length) {
			for (let p of this.points) {
				let from = changes ? changes.mapPos(p.from, 1) : p.from
				let to = changes ? changes.mapPos(p.to, -1) : p.to
				if (inRanges(changed, from, to)) {
					if (!p.block && p.deco.spec.widget) dropped.push({...p, from})
					continue
				}
				p.from = from
				p.to = Math.max(from, to)
				kept.push(p)
			}
		}
		let fresh: PointDeco[] = []
		let collect = (from: number, to: number) => {
			for (let set of this.sets) set.between(from, to, (f, t, deco) => {
				if (!deco.point || !("isReplace" in deco)) return
				let isBlock = !!(deco as any).block, isReplace = !!(deco as any).isReplace
				fresh.push({from: f, to: t, deco, side: deco.startSide < 0 ? -1 : 1, joins: false,
					block: isBlock && !isReplace, blockReplace: isBlock && isReplace})
			})
		}
		for (let i = 0; i < changed.length; i += 2) collect(changed[i], changed[i + 1])
		if (dropped.length) this.reuseWidgets(dropped, fresh)
		let order = (a: PointDeco, b: PointDeco) => a.from - b.from || a.side - b.side || a.to - b.to
		fresh.sort(order)
		let out: PointDeco[] = [], blocks = 0, covers = 0, lineEnd = -1
		this.joins = []
		let push = (p: PointDeco) => {
			// Dedupe (a point may be found by two adjacent ranges).
			let last = out[out.length - 1]
			if (last && last.from == p.from && last.to == p.to && last.deco == p.deco) return
			out.push(p)
			if (p.block || p.blockReplace) blocks++
			if (p.blockReplace) covers++
			p.joins = false
			// Points are sorted: look up a line once for all its points.
			if (p.to > p.from && p.from > lineEnd) lineEnd = doc.lineAt(p.from).to
			if (p.to > p.from && p.to > lineEnd) {
				p.joins = true
				let j = this.joins
				if (j.length && j[j.length - 1] >= p.from) j[j.length - 1] = Math.max(j[j.length - 1], p.to)
				else j.push(p.from, p.to)
			}
		}
		for (let i = 0, k = 0; i < kept.length || k < fresh.length;) {
			if (k == fresh.length || i < kept.length && order(kept[i], fresh[k]) <= 0) push(kept[i++])
			else push(fresh[k++])
		}
		this.points = out
		this.blockCount = blocks
		this.coverCount = covers
	}


	/// Like CodeMirror, a widget replacing one at the same position
	/// reuses its label when they're equal (no `toDOM`), and its DOM
	/// when `updateDOM` accepts it (the label is read again).
	private reuseWidgets(dropped: PointDeco[], fresh: PointDeco[]) {
		for (let p of fresh) {
			let widget = p.deco.spec.widget as WidgetType | undefined
			if (!widget || p.block || this.widgetSpecs.has(widget)) continue
			let i = dropped.findIndex(q => q.from == p.from && q.deco.spec.widget.constructor == widget!.constructor)
			if (i < 0) continue
			let old = dropped[i].deco.spec.widget as WidgetType, spec = this.widgetSpecs.get(old)
			if (!spec || old == widget) continue
			let dom = (spec as {dom?: HTMLElement}).dom
			if (widget.eq(old)) {
				this.widgetSpecs.set(widget, spec)
			} else if (dom && this.view && widget.updateDOM(dom, this.view, old)) {
				this.widgetSpecs.set(widget, this.readDOM(dom, this.view))
			} else {
				continue
			}
			if (dom) this.widgetDOM.set(dom, widget)
			dropped.splice(i, 1)
		}
	}

	/// Widget elements changed: read their labels again.
	private domChanged(records: MutationRecord[]) {
		let changed = new Set<WidgetType>()
		for (let r of records) {
			for (let node: Node | null = r.target; node; node = node.parentNode) {
				let widget = this.widgetDOM.get(node as HTMLElement)
				if (!widget) continue
				let spec = this.widgetSpecs.get(widget) as {dom?: HTMLElement} | undefined
				if (spec?.dom == node && this.view) {
					this.widgetSpecs.set(widget, this.readDOM(node as HTMLElement, this.view))
					changed.add(widget)
				}
				break
			}
		}
		if (!changed.size) return
		let ranges: number[] = []
		for (let p of this.points) if (changed.has(p.deco.spec.widget)) ranges.push(p.from, p.to)
		if (ranges.length) this.onWidgetChange(ranges)
	}

	destroy() { this.observer?.disconnect() }

	/// Rebuild everything (e.g. after a full state replacement).
	/// Forget all decorations (a new state, before its plugins exist).
	clear() {
		this.sets = []
		this.points = []
		this.joins = []
		this.blockCount = 0
		this.coverCount = 0
	}

	reset(view: EditorView, doc: Text) {
		this.sets = []
		this.points = []
		this.joins = []
		this.update(view, doc, null)
		this.points = []
		this.rebuildPoints(doc, null, [0, doc.length])
	}

	/// Points starting in [from, to].
	pointsIn(from: number, to: number, out: PointDeco[] = []) {
		// Points starting before `from` don't matter to a visual line
		// starting there: they would cross its line break and hide it.
		let ps = this.points
		let lo = 0, hi = ps.length
		while (lo < hi) {
			let mid = (lo + hi) >> 1
			if (ps[mid].from < from) lo = mid + 1
			else hi = mid
		}
		for (let i = lo; i < ps.length && ps[i].from <= to; i++) out.push(ps[i])
		return out
	}

	/// The join (replaced range across lines) covering `pos`, as an
	/// index into `joins`, or -1.
	joinAt(pos: number) {
		let j = this.joins, lo = 0, hi = j.length / 2
		while (lo < hi) {
			let mid = (lo + hi) >> 1
			if (j[mid * 2 + 1] < pos) lo = mid + 1
			else hi = mid
		}
		return lo < j.length / 2 && j[lo * 2] < pos && j[lo * 2 + 1] >= pos ? lo : -1
	}

	/// Style for a single mark decoration, or null when it draws nothing.
	resolve(deco: Decoration): ResolvedMark | null {
		let found = this.styleCache.get(deco)
		if (found !== undefined) return found
		let spec = deco.spec as {canvas?: MarkStyle, class?: string, attributes?: {[k: string]: string}}
		let style: MarkStyle | null = null
		let merge = (s: MarkStyle | null) => { if (s) style = {...style, ...s} }
		let cls = spec.class ?? spec.attributes?.class
		if (cls) for (let c of cls.split(" ")) if (c && !ignoredClasses.has(c)) merge(this.classStyle(c) ?? (this.dark() ? darkDefaults : lightDefaults)[c] ?? null)
		if (spec.attributes?.style) merge(parseInlineStyle(spec.attributes.style))
		if (spec.canvas) merge(spec.canvas)
		let result = style ? resolveMark(style) : null
		this.styleCache.set(deco, result)
		return result
	}

	/// A style id for a set of active marks (merged in order), or -1.
	combo(active: readonly Decoration[]) {
		if (!active.length) return -1
		if (active.length == 1) {
			let one = this.single.get(active[0])
			if (one != null) return one
		}
		let key = ""
		for (let d of active) {
			let id = this.decoIds.get(d)
			if (id == null) this.decoIds.set(d, id = this.nextId++)
			key += id + ","
		}
		let found = this.combos.get(key)
		if (found == null) {
			let merged: ResolvedMark | null = null
			for (let d of active) {
				let r = this.resolve(d)
				if (r) merged = merged ? mergeResolved(merged, r) : r
			}
			found = merged ? this.marks.push(merged) - 1 : -1
			if (this.combos.size > 2000) this.combos.clear()
			this.combos.set(key, found)
		}
		if (active.length == 1) this.single.set(active[0], found)
		return found
	}

	/// Mark runs for document range [from, to), relative to `base`, as
	/// flat `[from, to, styleId]` triples (style ids index `marks`).
	/// Also reports line decorations at line starts through `onLine`.
	markRuns(from: number, to: number, base: number, out: number[], onLine?: (pos: number, deco: Decoration) => void) {
		out.length = 0
		if (!this.sets.length) return out
		RangeSet.spans(this.sets, from, to, {
			span: (f, t, active) => {
				if (!active.length) return
				let id = this.combo(active as Decoration[])
				if (id < 0) return
				let n = out.length
				if (n && out[n - 1] == id && out[n - 2] == f - base) out[n - 2] = t - base
				else out.push(f - base, t - base, id)
			},
			point: (f, t, deco) => {
				if (onLine && f == t && !("isReplace" in deco)) onLine(f, deco as Decoration)
			}
		})
		// Line decorations at `from` itself are reported only when the
		// range starts there.
		return out
	}

	/// Line decoration style at a line start (merged), or null.
	lineStyle(lineFrom: number): ResolvedMark | null {
		let style: ResolvedMark | null = null
		for (let set of this.sets) set.between(lineFrom, lineFrom, (f, t, deco) => {
			if (f != lineFrom || t != lineFrom || !deco.point || "isReplace" in deco) return
			let r = this.resolve(deco)
			if (r) style = style ? mergeResolved(style, r) : r
		})
		return style
	}

	/// The label a widget draws.
	widgetSpec(widget: WidgetType, view: EditorView): CanvasWidgetSpec {
		let found = this.widgetSpecs.get(widget)
		if (found) return found
		let w = widget as WidgetType & {toCanvas?: (view: EditorView) => CanvasWidgetSpec}
		if (typeof w.toCanvas == "function") {
			found = w.toCanvas(view)
		} else {
			try {
				let dom = widget.toDOM(view)
				this.widgetDOM.set(dom, widget)
				domViews.set(dom, view)
				found = this.readDOM(dom, view)
				this.observer?.observe(dom, {childList: true, characterData: true, attributes: true, subtree: true})
			} catch (e) {
				console.warn("canvas-view: widget toDOM failed", e)
			}
			found ??= {text: ""}
		}
		this.widgetSpecs.set(widget, found)
		return found
	}

	/// A widget label from its DOM: text, classes, inline style, and
	/// for empty elements with a size, a box (color chips...).
	private readDOM(dom: HTMLElement, view: EditorView): CanvasWidgetSpec {
		let style: MarkStyle | undefined, padLeft = 0, padRight = 0
		let text = (dom.textContent ?? "").replace(/\s+/g, " ")
		let cls = dom.className && typeof dom.className == "string" ? dom.className : ""
		for (let c of cls.split(" ")) {
			if (!c) continue
			if (c.endsWith("-pl")) padLeft = 0.5
			else if (c.endsWith("-pr")) padRight = 0.5
			let s = this.classStyle(c) ?? (this.dark() ? darkDefaults : lightDefaults)[c]
			if (s) style = {...style, ...s}
		}
		let cells: number | undefined
		if (dom.style?.cssText) {
			style = {...style, ...parseInlineStyle(dom.style.cssText)}
			// An empty element with a size (color chips...): a box.
			if (!text) {
				let size = (v: string) => {
					let m = /^([\d.]+)(px|em|ch|rem)?$/.exec(v.trim())
					if (!m) return 0
					let n = +m[1], cw = (view as any).defaultCharacterWidth || 8, fs = (view as any).fontSizePx || 14
					return m[2] == "em" || m[2] == "rem" ? n * fs / cw : m[2] == "ch" ? n : n / cw
				}
				let w = size(dom.style.width || "")
				if (w > 0) {
					cells = Math.max(0.5, Math.round(w * 4) / 4)
					let ml = size(dom.style.marginLeft || ""), mr = size(dom.style.marginRight || "")
					padLeft += ml
					padRight += mr
					if (/radius/.test(dom.style.cssText)) style = {...style, rounded: true}
				}
			}
		}
		// CodeMirror's lint points: an empty span drawn by CSS (::after).
		let point = !text && /(^| )cm-lintPoint( |$)/.test(cls) ? style?.underlineColor : undefined
		return {text, style, padLeft, padRight, dom, cells, point} as CanvasWidgetSpec
	}

	/// The DOM element of a widget's label: the one read for it, or, for
	/// a widget drawn with `toCanvas`, one made by `toDOM` when first
	/// asked (a tap goes to it, so the widget's event handlers work).
	widgetElement(widget: WidgetType, view: EditorView): HTMLElement | null {
		let spec = this.widgetSpecs.get(widget) as any
		if (!spec) return null
		if (spec.dom) return spec.dom
		let lazy = this.lazyDOM.get(widget)
		if (lazy === undefined && typeof (widget as any).toCanvas == "function") {
			try {
				lazy = widget.toDOM(view)
				this.widgetDOM.set(lazy, widget)
				domViews.set(lazy, view)
			} catch {
				lazy = null
			}
			this.lazyDOM.set(widget, lazy)
		}
		return lazy ?? null
	}

	private lazyDOM = new WeakMap<WidgetType, HTMLElement | null>()

	clearStyles() {
		this.styleCache = new WeakMap()
		this.decoIds = new WeakMap()
		this.single = new WeakMap()
		this.combos.clear()
		this.marks = []
		this.widgetSpecs = new WeakMap()
	}
}

export function resolveMark(s: MarkStyle): ResolvedMark {
	let c = (v: string | undefined) => v ? parseColor(v) : null
	return {
		color: c(s.color), background: c(s.background),
		underline: s.underline == "wavy" ? 2 : s.underline == "solid" ? 1 : 0,
		underlineColor: c(s.underlineColor), strike: !!s.strike,
		bold: s.bold ?? null, italic: s.italic ?? null, border: c(s.border), rounded: !!s.rounded
	}
}

function mergeResolved(a: ResolvedMark, b: ResolvedMark): ResolvedMark {
	return {
		color: b.color ?? a.color, background: b.background ?? a.background,
		underline: b.underline || a.underline, underlineColor: b.underlineColor ?? a.underlineColor,
		strike: a.strike || b.strike, bold: b.bold ?? a.bold, italic: b.italic ?? a.italic,
		border: b.border ?? a.border, rounded: a.rounded || b.rounded
	}
}

/// The few inline-style properties a canvas can draw.
export function parseInlineStyle(css: string): MarkStyle | null {
	let out: MarkStyle = {}, any = false
	for (let decl of css.split(";")) {
		let colon = decl.indexOf(":")
		if (colon < 0) continue
		let prop = decl.slice(0, colon).trim().toLowerCase(), value = decl.slice(colon + 1).trim()
		if (!value) continue
		any = true
		if (prop == "color") out.color = value
		else if (prop == "background-color" || prop == "background" && !/url\(|gradient/.test(value)) out.background = value
		else if (prop == "font-weight") out.bold = value == "bold" || +value >= 600
		else if (prop == "font-style") out.italic = value == "italic" || value == "oblique"
		else if (prop == "text-decoration" || prop == "text-decoration-line") {
			if (value.includes("underline")) out.underline = value.includes("wavy") ? "wavy" : "solid"
			if (value.includes("line-through")) out.strike = true
		} else if (prop == "border" || prop == "outline") {
			let m = /(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)\s*$/i.exec(value)
			if (m && m[1] != "none") out.border = m[1]
		}
	}
	return any ? out : null
}

function addRange(ranges: number[], from: number, to: number) {
	let n = ranges.length
	if (n && ranges[n - 1] >= from) ranges[n - 1] = Math.max(ranges[n - 1], to)
	else ranges.push(from, to)
}

function inRanges(ranges: readonly number[], from: number, to: number) {
	for (let i = 0; i < ranges.length; i += 2) if (ranges[i] <= to && ranges[i + 1] >= from) return true
	return false
}
