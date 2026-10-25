import {type ChangeDesc, MapMode, type Text} from "@codemirror/state"
import type {FontVariant, GlyphAtlas, GlyphEntry} from "../core/atlas"
import {type PackedColor, parseColor} from "../core/color"
import {GLYPH_STRIDE, InstanceBuffer, pushGlyph, pushRect, RECT_STRIDE} from "../core/instances"
import {type CanvasWidgetSpec, type DecoState, type ResolvedMark, resolveMark} from "./decorations"
import {mirrorChar} from "./bidi"
import {type Cluster, ClusterKind, type LineLayouts} from "./layout"
import {clustersOf, type LineModel, type Piece, PieceKind, type VLine} from "./lines"
import type {LineRuns, SyntaxDriver} from "./syntax"

/// A text style: font variant plus tint color.
export interface TextStyle {
	variant: FontVariant
	color: PackedColor
}

export interface TokenDeco {
	bg: PackedColor | null
	underline: boolean
	strike: boolean
	color: PackedColor
}

/// What the scene needs from the view.
export interface SceneHost {
	readonly atlas: GlyphAtlas
	readonly layouts: LineLayouts
	readonly lines: LineModel
	readonly decos: DecoState
	readonly lineHeight: number
	readonly cellWidth: number
	/// Style table; style ids index into it.
	readonly styles: readonly TextStyle[]
	readonly defaultStyle: number
	readonly gutterStyle: number
	/// x of the right edge of line numbers, in gutter coordinates.
	readonly gutterRight: number
	styleForClass(id: number): number
	decoForClass(id: number): TokenDeco | null
	/// Style id for a font variant and color (mark overrides, labels).
	styleFor(variant: FontVariant, color: PackedColor): number
	/// A one-cell-wide wave (tiles horizontally) for wavy underlines.
	waveGlyph(): GlyphEntry
	/// Indent guides: color (null = off), and the indentation (columns)
	/// and guide spacing for line `n` (written to `guide`).
	readonly indentGuideColor: PackedColor | null
	/// Rainbow bracket colors (null = off), and the brackets of line `n`
	/// as flat [offset, colorIndex] pairs (null: not known yet).
	readonly rainbowColors: readonly PackedColor[] | null
	lineBrackets(n: number): readonly number[] | null
	/// The syntax driver reported new highlighting from `pos` on.
	syntaxChanged(pos: number): void
	/// A widget's own drawing (full color), `w`×`h` CSS px.
	widgetImage(label: CanvasWidgetSpec, w: number, h: number): GlyphEntry
	/// A rounded box (filled, or its 1px outline) as a tintable shape.
	roundedBox(w: number, h: number, outline: boolean): GlyphEntry
	/// A point mark's triangle (lint points) as a tintable shape.
	pointGlyph(): GlyphEntry
	/// Device pixels per CSS pixel (atlas shapes are in device pixels).
	readonly dpr: number
	/// Whitespace markers (null = off).
	readonly whitespace: {color: PackedColor, trailing: PackedColor | null, spaces: boolean, lineBreaks: boolean} | null
	guideInfo(n: number, text: string): {indent: number, step: number}
}

interface Segment {
	/// Validation stamp; segments with an old stamp are re-checked.
	stamp: number
	/// First document line of the visual line.
	line: number
	from: number
	vline: VLine
	runs: LineRuns | null
	brackets: readonly number[] | null
	exact: boolean
	/// Emitted (unwrapped) column window; `complete` when all of it was.
	colFrom: number
	colTo: number
	complete: boolean
	/// Row the instances were emitted for.
	row: number
	forced: boolean
	g0: number
	gN: number
	r0: number
	rN: number
}

interface GutterSegment {
	n0: number
	nN: number
	row: number
	/// The number drawn (another line's after a block replace at the start).
	num: number
}

/// Unwrapped lines up to this many columns are always emitted whole,
/// so horizontal scrolling never re-emits them.
const FULL_LINE_COLS = 512
/// Wrapped lines up to this many rows are emitted whole.
const FULL_WRAP_ROWS = 256
/// Re-base scene coordinates when this far (px) from the origin, to
/// keep float32 positions precise.
const MAX_ORIGIN_DISTANCE = 400_000
/// Far-reaching rects (line backgrounds): clipped by the pass.
const FAR = 1e6
/// Margin lines emitted between deadline checks.
const MARGIN_BATCH = 8

/// The static scene: per-visual-line segments of glyph and rect
/// instances in coordinates relative to `origin` (a row). Lines
/// entering the buffered range are appended; leaving or stale lines are
/// blanked and reclaimed by in-place compaction. Scrolling therefore
/// only ever emits the few lines that scroll into range, and edits
/// re-emit only changed lines. When rows move (edits above, folds,
/// re-measured wrapping), segments are shifted in place.
export class Scene {
	readonly glyphs = new InstanceBuffer(GLYPH_STRIDE, 8192)
	readonly rects = new InstanceBuffer(RECT_STRIDE, 256)
	readonly gutter = new InstanceBuffer(GLYPH_STRIDE, 1024)
	/// Row that scene y = 0 corresponds to.
	origin = 0
	private segments = new Map<number, Segment>()
	private gutterSegs = new Map<number, GutterSegment>()
	/// Segments emitted for only part of their line.
	private partial = new Set<Segment>()
	private deadGlyphs = 0
	private deadRects = 0
	private deadGutter = 0
	private doc: Text | null = null
	private stamp = 0
	/// Lines known current for `stamp` (a contiguous range).
	private ready = {stamp: -1, first: 1, last: 0}
	private lastWant = {first: -1, last: -1}
	private key: unknown[] = []
	private rowsVersion = -1
	private rowsDirty = false
	/// Document ranges whose decorations changed, as [from, to] pairs.
	private forced: number[] = []
	private markScratch: number[] = []
	private labelStyles = new WeakMap<object, ResolvedMark | null>()
	/// Lines emitted by the last `ensure` call (diagnostics).
	emitted = 0

	constructor(private host: SceneHost) {}

	/// Drop everything (font, theme, atlas generation or gutter change).
	reset(origin: number) {
		this.glyphs.reset()
		this.rects.reset()
		this.gutter.reset()
		this.segments.clear()
		this.gutterSegs.clear()
		this.partial.clear()
		this.deadGlyphs = this.deadRects = this.deadGutter = 0
		this.origin = origin
		this.stamp++
		this.lastWant.first = -1
		this.forced.length = 0
	}

	/// Map segments through a document change: unchanged lines keep
	/// their instances (they are moved by `syncRows`).
	mapChanges(changes: ChangeDesc, doc: Text) {
		let next = new Map<number, Segment>()
		for (let seg of this.segments.values()) {
			let from = changes.mapPos(seg.from, 1, MapMode.TrackDel)
			let line = from == null ? null : doc.lineAt(from)
			if (!line || line.from != from) {
				this.kill(seg)
				continue
			}
			seg.line = line.number
			seg.from = from
			if (next.has(line.number)) this.kill(next.get(line.number)!)
			next.set(line.number, seg)
		}
		this.segments = next
		for (let [n, g] of this.gutterSegs) if (n > doc.lines) this.killGutter(n, g)
		this.rowsDirty = true
	}

	/// Decorations changed in these document ranges ([from, to] pairs):
	/// re-emit the lines there when next needed.
	invalidate(ranges: readonly number[]) {
		for (let r of ranges) this.forced.push(r)
	}

	/// Move segments whose row changed (edits, folds, wrapping).
	private syncRows(doc: Text) {
		let lines = this.host.lines
		if (!this.rowsDirty && this.rowsVersion == lines.version) return
		this.rowsDirty = false
		this.rowsVersion = lines.version
		let lh = this.host.lineHeight
		for (let seg of this.segments.values()) {
			if (lines.hidden(seg.line)) { this.kill(seg); continue }
			let row = lines.rowOf(seg.line)
			if (row != seg.row) {
				this.shiftY(seg, (row - seg.row) * lh)
				seg.row = row
			}
		}
		for (let [n, g] of this.gutterSegs) {
			if (n > doc.lines || lines.hidden(n) || lines.covered(n)) { this.killGutter(n, g); continue }
			let {row, num} = this.numberAt(n)
			if (num != g.num) { this.killGutter(n, g); continue }
			if (row != g.row) {
				let buf = this.gutter, dy = (row - g.row) * lh
				for (let i = g.n0; i < g.n0 + g.nN; i++) buf.f32[i * GLYPH_STRIDE + 1] += dy
				buf.touch(g.n0)
				g.row = row
			}
		}
	}

	/// Make sure lines `need` are present and current (and those in
	/// `want`, nearest the scroll direction first, while time remains
	/// before `deadline`). `colFirst..colLast` is the visible column
	/// window (unwrapped mode) and `rowFirst..rowLast` the visible rows.
	ensure(doc: Text, syntax: SyntaxDriver, needFirst: number, needLast: number, wantFirst: number, wantLast: number,
		colFirst: number, colLast: number, rowFirst: number, rowLast: number,
		key: unknown[], deadline: number, lineNumbers: boolean, forward: boolean) {
		this.emitted = 0
		let lh = this.host.lineHeight, lines = this.host.lines
		if (key.length != this.key.length || key.some((v, i) => v !== this.key[i]) ||
			Math.abs(rowFirst - this.origin) * lh > MAX_ORIGIN_DISTANCE) {
			this.key = key
			this.reset(rowFirst)
		}
		if (this.doc !== doc) this.stamp++
		this.doc = doc
		this.syncRows(doc)
		if (wantFirst != this.lastWant.first || wantLast != this.lastWant.last) {
			this.lastWant.first = wantFirst
			this.lastWant.last = wantLast
			syntax.setVisible(doc.line(wantFirst).from, doc.line(wantLast).to)
		}
		syntax.workVisible()
		let changed = syntax.takeChanged()
		if (changed && changed.other >= 0) this.host.syntaxChanged(changed.other)
		let span = colLast - colFirst
		// Long lines are emitted for the visible window plus a margin.
		let win = {colFrom: Math.max(0, colFirst - span), colTo: colLast + span, rowFrom: rowFirst - (rowLast - rowFirst), rowTo: rowLast * 2 - rowFirst}
		let vis = {colFrom: colFirst, colTo: colLast, rowFrom: rowFirst, rowTo: rowLast}
		let stamp = this.stamp
		let ready = this.ready
		if (ready.stamp != stamp) {
			ready.stamp = stamp
			ready.first = 1
			ready.last = 0
		}

		let process = (first: number, last: number) => {
			let n = first
			while (n <= last) {
				if (this.segments.get(n)?.stamp === stamp) { n++; continue }
				let end = n
				while (end < last && this.segments.get(end + 1)?.stamp !== stamp) end++
				// Fetch runs for the whole range in one batch.
				syntax.runsFor(n, end, (k, runs, exact) => {
					let seg = this.segments.get(k)
					if (lines.hidden(k)) {
						if (seg) this.kill(seg)
						return
					}
					let vl = lines.vline(k)
					let brackets = this.host.rainbowColors ? this.host.lineBrackets(k) : null
					if (seg) {
						if (!seg.forced && seg.vline === vl && sameRuns(seg.runs, runs) && sameRuns(seg.brackets, brackets) && this.covers(seg, vis)) {
							seg.exact = exact
							seg.runs = runs
							seg.stamp = stamp
							return
						}
						this.kill(seg)
					}
					this.emitLine(k, vl, runs, brackets, exact, lines.rowOf(k), win, syntax)
				})
				n = end + 1
			}
			if (lineNumbers) for (let k = first; k <= last; k++)
				if (!this.gutterSegs.has(k) && !lines.hidden(k) && !lines.covered(k)) this.emitNumber(k)
		}
		let recheck = (from: number, to: number) => {
			if (ready.last < ready.first) return
			let a = Math.max(ready.first, from > doc.length ? ready.last + 1 : lines.vlineStart(doc.lineAt(Math.min(from, doc.length)).number))
			let b = Math.min(ready.last, doc.lineAt(Math.min(to, doc.length)).number)
			if (a > b) return
			for (let n = a; n <= b; n++) {
				let seg = this.segments.get(n)
				if (seg) seg.stamp = -1
			}
			process(a, b)
		}
		// New highlighting: re-check just the affected lines that are
		// already in the scene.
		if (changed) recheck(changed.from, changed.to)
		if (this.forced.length) {
			let f = this.forced
			this.forced = []
			for (let i = 0; i < f.length; i += 2) {
				let a = doc.lineAt(Math.min(f[i], doc.length)).number, b = doc.lineAt(Math.min(f[i + 1], doc.length)).number
				for (let n = Math.max(ready.first, lines.vlineStart(a)), e = Math.min(b, ready.last); n <= e; n++) {
					let seg = this.segments.get(n)
					if (seg) seg.forced = true
				}
				recheck(f[i], f[i + 1])
			}
		}
		// Partially emitted lines that no longer cover what's visible.
		if (this.partial.size) {
			for (let seg of this.partial) {
				if (seg.line < needFirst || seg.line > needLast || this.covers(seg, vis)) continue
				seg.stamp = -1
				seg.forced = true
				process(seg.line, seg.line)
			}
		}
		// Only lines outside the range already known to be current need
		// any work, so a steady frame costs nothing here.
		let cover = (a: number, b: number) => {
			if (b < a) return
			if (ready.last < ready.first || b < ready.first - 1 || a > ready.last + 1) {
				process(a, b)
				ready.first = a
				ready.last = b
				return
			}
			if (a < ready.first) process(a, ready.first - 1)
			if (b > ready.last) process(ready.last + 1, b)
			ready.first = Math.min(a, ready.first)
			ready.last = Math.max(b, ready.last)
		}
		cover(needFirst, needLast)
		// Margin lines in small batches, so first-time work (layout,
		// bidi, rasterizing new glyphs) stops at the deadline instead of
		// running a whole margin past it.
		let ahead = () => {
			for (let a = Math.max(needLast, ready.last) + 1; a <= wantLast && performance.now() < deadline; a += MARGIN_BATCH)
				cover(a, Math.min(wantLast, a + MARGIN_BATCH - 1))
		}
		let behind = () => {
			for (let b = Math.min(needFirst, ready.first) - 1; b >= wantFirst && performance.now() < deadline; b -= MARGIN_BATCH)
				cover(Math.max(wantFirst, b - MARGIN_BATCH + 1), b)
		}
		if (forward) { ahead(); behind() } else { behind(); ahead() }
		this.evict(wantFirst, wantLast, needLast - needFirst + 1)
		this.compactIfNeeded()
	}

	/// Whether a segment's emitted window covers the visible window.
	private covers(seg: Segment, win: {colFrom: number, colTo: number, rowFrom: number, rowTo: number}) {
		if (seg.complete) return true
		let {from, to} = this.windowFor(seg.vline, seg.row, win)
		return seg.colFrom <= from && seg.colTo >= to
	}

	/// The unwrapped column window to emit for a long line.
	private windowFor(vl: VLine, row: number, win: {colFrom: number, colTo: number, rowFrom: number, rowTo: number}) {
		let lines = this.host.lines
		// Bidi lines draw columns out of order: map the visible x range.
		if (!vl.breaks) return vl.bidi ? lines.colWindow(vl, 0, win.colFrom, win.colTo) : {from: win.colFrom, to: win.colTo}
		let r0 = Math.max(0, win.rowFrom - row), r1 = Math.min(vl.rows - 1, win.rowTo - row)
		if (r1 < r0) return {from: 0, to: 0}
		return {from: lines.rowStartCol(vl, r0), to: lines.rowEndCol(vl, r1)}
	}

	/// For stats: visible lines without colors / with provisional colors.
	coverage(first: number, last: number) {
		let plain = 0, approx = 0
		for (let n = first; n <= last; n++) {
			let seg = this.segments.get(n)
			if (!seg) continue
			if (!seg.runs) plain++
			else if (!seg.exact) approx++
		}
		return {plain, approx}
	}

	private evict(wantFirst: number, wantLast: number, screen: number) {
		let keepFrom = wantFirst - screen * 2, keepTo = wantLast + screen * 2
		this.ready.first = Math.max(this.ready.first, keepFrom)
		this.ready.last = Math.min(this.ready.last, keepTo)
		if (this.segments.size > (keepTo - keepFrom + 1) * 1.5) {
			for (let seg of this.segments.values()) if (seg.line < keepFrom || seg.line > keepTo) this.kill(seg)
		}
		if (this.gutterSegs.size > (keepTo - keepFrom + 1) * 1.5) {
			for (let [n, g] of this.gutterSegs) if (n < keepFrom || n > keepTo) this.killGutter(n, g)
		}
	}

	private emitLine(n: number, vl: VLine, runs: LineRuns | null, brackets: readonly number[] | null, exact: boolean, row: number,
		win: {colFrom: number, colTo: number, rowFrom: number, rowTo: number}, syntax: SyntaxDriver) {
		this.emitted++
		let host = this.host, decos = host.decos
		let g0 = this.glyphs.count, r0 = this.rects.count
		let complete = vl.breaks ? vl.rows <= FULL_WRAP_ROWS : vl.width <= FULL_LINE_COLS
		let {from: colFrom, to: colTo} = complete ? {from: 0, to: Infinity} : this.windowFor(vl, row, win)
		let seg: Segment = {stamp: this.stamp, line: n, from: vl.from, vline: vl, runs, brackets, exact, colFrom, colTo, complete,
			row, forced: false, g0, gN: 0, r0, rN: 0}
		this.segments.set(n, seg)
		if (!complete) this.partial.add(seg)
		// A block replace's widget DOM draws the whole visual line.
		if (vl.cover) return
		let lh = host.lineHeight
		let baseY = (row - this.origin) * lh

		if (!decos.empty) {
			let ls = decos.lineStyle(vl.from)
			if (ls?.background != null) pushRect(this.rects, -FAR, baseY, 2 * FAR, vl.rows * lh, ls.background)
		}
		let guides = host.indentGuideColor
		// Right-to-left paragraphs have their indentation on the right.
		if (guides != null && !vl.rtl) {
			// VS Code-style guides: one per indent level, through the rows
			// of the line whose text starts right of them.
			let {indent, step: unit} = host.guideInfo(n, vl.text), cw = host.cellWidth
			for (let col = 0; col < indent && col >= colFrom - unit; col += unit) {
				if (col >= colTo) continue
				if (vl.rows == 1) pushRect(this.rects, col * cw, baseY, 1, lh, guides)
				else host.lines.guideRows(vl, col, (a, b) => pushRect(this.rects, col * cw, baseY + a * lh, 1, (b - a) * lh, guides!))
			}
		}
		let em = this.emitContent(this.glyphs, this.rects, vl, runs, brackets, baseY, colFrom, colTo, syntax)
		if (host.whitespace) em.whitespace(n, vl, host.whitespace, this.doc!)
		seg.gN = this.glyphs.count - g0
		seg.rN = this.rects.count - r0
	}

	/// A visual line's text, widget labels and decoration rects, columns
	/// `colFrom..colTo`, into the given buffers.
	private emitContent(glyphs: InstanceBuffer, rects: InstanceBuffer, vl: VLine, runs: LineRuns | null, brackets: readonly number[] | null,
		baseY: number, colFrom: number, colTo: number, syntax: SyntaxDriver) {
		let host = this.host, decos = host.decos
		let marks = decos.empty ? null : decos.markRuns(vl.from, vl.to, vl.from, this.markScratch)
		if (marks && !marks.length) marks = null
		let em = new Emitter(glyphs, rects, host, vl, baseY, colFrom, colTo, marks)
		if (!vl.pieces) {
			if (vl.text.length) em.text(vl.text, clustersOf(host.layouts, vl), 0, 0, vl.text.length, 0, runs, brackets)
		} else {
			let lineNo: number, lineRuns = runs, lineStart = 0, lineBrackets = brackets
			for (let p of vl.pieces) {
				if (p.kind == PieceKind.Text) {
					if (p.lineStart != lineStart) {
						// A later document line of a joined visual line.
						lineStart = p.lineStart
						lineNo = this.doc!.lineAt(vl.from + p.lineStart).number
						lineRuns = null
						syntax.runsFor(lineNo, lineNo, (_k, r) => { lineRuns = r })
						lineBrackets = host.rainbowColors ? host.lineBrackets(lineNo) : null
					}
					if (p.to > p.from) em.text(p.text, clustersOf(host.layouts, p), p.lineStart, p.from - p.lineStart, p.to - p.lineStart, p.col - p.colBase,
						lineRuns, lineBrackets)
				} else if (p.label && p.cells > 0) {
					em.label(p, this.labelStyle(p))
				} else if (p.label?.point) {
					em.point(p, p.label.point)
				}
			}
		}
		em.finish()
		return em
	}

	/// Draw the first row of a visual line into other buffers, at `y`
	/// (sticky scroll's header lines): the same text, colors, marks and
	/// widget labels as in the scene, without indent guides, whitespace
	/// markers or line backgrounds. `colFrom..colTo` limits long lines.
	emitRow(glyphs: InstanceBuffer, rects: InstanceBuffer, vl: VLine, runs: LineRuns | null, brackets: readonly number[] | null,
		y: number, colFrom: number, colTo: number, syntax: SyntaxDriver) {
		if (vl.cover) return
		let lines = this.host.lines
		if (vl.breaks) {
			colFrom = 0
			colTo = lines.rowEndCol(vl, 0)
		} else if (vl.width <= FULL_LINE_COLS) {
			colFrom = 0
			colTo = Infinity
		} else if (vl.bidi) {
			let w = lines.colWindow(vl, 0, colFrom, colTo)
			colFrom = w.from
			colTo = w.to
		}
		this.emitContent(glyphs, rects, vl, runs, brackets, y, colFrom, colTo, syntax)
	}

	private labelStyle(p: Piece) {
		let label = p.label!
		let found = this.labelStyles.get(label)
		if (found === undefined) {
			found = label.style ? resolveMark(label.style) : null
			this.labelStyles.set(label, found)
		}
		return found
	}

	/// Row and number of line `n`'s line number: after a block replace at
	/// its start, on its first text row, with that row's line.
	private numberAt(n: number) {
		let lines = this.host.lines, row = lines.rowOf(n)
		if (!this.host.decos.coverCount) return {row, num: n}
		let t = lines.textRow(lines.vline(n))
		return {row: row + t.row, num: t.line}
	}

	private emitNumber(n: number) {
		let host = this.host, cw = host.cellWidth, buf = this.gutter
		let {row, num} = this.numberAt(n)
		let n0 = buf.count, str = String(num), y = (row - this.origin) * host.lineHeight
		for (let i = 0; i < str.length; i++) {
			let st = host.styles[host.gutterStyle]
			let g = host.atlas.asciiGlyph(st.variant, str.charCodeAt(i))
			pushGlyph(buf, host.gutterRight - (str.length - i) * cw + g.ox, y + g.oy, g, st.color)
		}
		this.gutterSegs.set(n, {n0, nN: buf.count - n0, row, num})
	}

	/// Blank a segment's instances (zero size) and forget it.
	private kill(seg: Segment) {
		blankGlyphs(this.glyphs, seg.g0, seg.gN)
		blankRects(this.rects, seg.r0, seg.rN)
		this.deadGlyphs += seg.gN
		this.deadRects += seg.rN
		this.partial.delete(seg)
		if (this.segments.get(seg.line) === seg) this.segments.delete(seg.line)
	}

	private killGutter(n: number, g: GutterSegment) {
		blankGlyphs(this.gutter, g.n0, g.nN)
		this.deadGutter += g.nN
		this.gutterSegs.delete(n)
	}

	private shiftY(seg: Segment, dy: number) {
		let g = this.glyphs, r = this.rects
		for (let i = seg.g0; i < seg.g0 + seg.gN; i++) g.f32[i * GLYPH_STRIDE + 1] += dy
		for (let i = seg.r0; i < seg.r0 + seg.rN; i++) r.f32[i * RECT_STRIDE + 1] += dy
		g.touch(seg.g0)
		r.touch(seg.r0)
	}

	private compactIfNeeded() {
		let g = this.glyphs
		if (this.deadGlyphs > 4096 && this.deadGlyphs * 2 > g.count) this.compactText()
		if (this.deadGutter > 2048 && this.deadGutter * 2 > this.gutter.count) this.compactGutter()
	}

	private compactText() {
		let segs = [...this.segments.values()]
		segs.sort((a, b) => a.g0 - b.g0)
		let g = this.glyphs, at = 0
		for (let s of segs) {
			if (s.gN && s.g0 != at) g.u32.copyWithin(at * GLYPH_STRIDE, s.g0 * GLYPH_STRIDE, (s.g0 + s.gN) * GLYPH_STRIDE)
			s.g0 = at
			at += s.gN
		}
		g.count = at
		g.touch(0)
		segs.sort((a, b) => a.r0 - b.r0)
		let r = this.rects
		at = 0
		for (let s of segs) {
			if (s.rN && s.r0 != at) r.u32.copyWithin(at * RECT_STRIDE, s.r0 * RECT_STRIDE, (s.r0 + s.rN) * RECT_STRIDE)
			s.r0 = at
			at += s.rN
		}
		r.count = at
		r.touch(0)
		this.deadGlyphs = this.deadRects = 0
	}

	private compactGutter() {
		let segs = [...this.gutterSegs.values()].sort((a, b) => a.n0 - b.n0)
		let g = this.gutter, at = 0
		for (let s of segs) {
			if (s.nN && s.n0 != at) g.u32.copyWithin(at * GLYPH_STRIDE, s.n0 * GLYPH_STRIDE, (s.n0 + s.nN) * GLYPH_STRIDE)
			s.n0 = at
			at += s.nN
		}
		g.count = at
		g.touch(0)
		this.deadGutter = 0
	}
}

/// Emits one visual line's glyphs and rects: tracks the current row
/// (wrapping), syntax and mark styles, and decoration rect runs.
class Emitter {
	private glyphs: InstanceBuffer
	private rects: InstanceBuffer
	private cw: number
	private lh: number
	private breaks: number[] | null
	/// Current row: index, start column, next break column, y.
	private ri = 0
	private rs = 0
	private next: number
	private y: number
	/// x (cells) where the current row's content starts.
	private rx = 0
	private lines: LineModel
	// Decoration rect runs (columns): syntax token decoration and marks.
	private synFrom = -1
	private synCls = -1
	private markFrom = -1
	private markId = -1

	constructor(glyphs: InstanceBuffer, rects: InstanceBuffer, private host: SceneHost, private vl: VLine, private baseY: number,
		private colFrom: number, private colTo: number, private marks: number[] | null) {
		this.glyphs = glyphs
		this.rects = rects
		this.cw = host.cellWidth
		this.lh = host.lineHeight
		this.breaks = vl.breaks
		this.next = this.breaks ? this.breaks[0] : Infinity
		this.y = baseY
		this.lines = host.lines
	}

	/// x (cells) of a unit at column `col`, `cells` wide, on the current
	/// row (bidi lines place runs out of column order).
	private rtlAt(col: number) {
		let run = this.lines.runAtCol(this.vl, this.ri, col)
		return run != null && (run.level & 1) == 1
	}

	private xOf(col: number, cells: number) {
		return this.vl.bidi ? this.lines.boxX(this.vl, this.ri, col, cells) : col - this.rs + this.rx
	}

	private advance(col: number) {
		let br = this.breaks!
		while (col >= this.next) {
			this.rs = this.next
			this.ri++
			this.next = this.ri < br.length ? br[this.ri] : Infinity
		}
		this.y = this.baseY + this.ri * this.lh
		// Continuation rows start at the wrap indent.
		this.rx = this.lines.rowX(this.vl, this.ri)
	}

	/// Text of a document line, offsets `from..to` (line-relative), whose
	/// line starts at `lineStart` in the visual line, with columns
	/// shifted by `colShift`.
	text(text: string, clusters: Cluster[] | null, lineStart: number, from: number, to: number, colShift: number, runs: LineRuns | null,
		brackets: readonly number[] | null = null) {
		let rainbow = brackets && brackets.length ? this.host.rainbowColors : null, bi = 0
		let host = this.host, atlas = host.atlas, styles = host.styles, def = host.defaultStyle
		let glyphs = this.glyphs, cw = this.cw, marks = this.marks, bidi = this.vl.bidi != null
		let colFrom = this.colFrom, colTo = this.colTo
		// Style state: syntax run index/end, mark index/end.
		let ri = 0, rEnd = -1, cls = -1, synStyle = def
		let mi = 0, mEnd = -1, mark = -1
		let style = def
		let styleAt = (i: number) => {
			if (i >= rEnd) {
				if (!runs) { cls = -1; synStyle = def; rEnd = Infinity }
				else {
					while (ri < runs.length && i >= runs[ri + 1]) ri += 3
					if (ri < runs.length && i >= runs[ri]) {
						cls = runs[ri + 2]
						rEnd = runs[ri + 1]
						synStyle = host.styleForClass(cls)
					} else {
						cls = -1
						synStyle = def
						rEnd = ri < runs.length ? runs[ri] : Infinity
					}
				}
			}
			// Marks are relative to the visual line; `mEnd` too.
			if (marks && i + lineStart >= mEnd) {
				let p = i + lineStart
				while (mi < marks.length && p >= marks[mi + 1]) mi += 3
				if (mi < marks.length && p >= marks[mi]) {
					mark = marks[mi + 2]
					mEnd = marks[mi + 1]
				} else {
					mark = -1
					mEnd = mi < marks.length ? marks[mi] : Infinity
				}
			}
			style = synStyle
			if (mark >= 0) {
				let m = host.decos.marks[mark]
				if (m.color != null || m.bold != null || m.italic != null) {
					let base = styles[synStyle]
					let v = base.variant
					if (m.bold != null) v = ((v & ~1) | (m.bold ? 1 : 0)) as FontVariant
					if (m.italic != null) v = ((v & ~2) | (m.italic ? 2 : 0)) as FontVariant
					style = host.styleFor(v, m.color ?? base.color)
				}
			}
			return Math.min(rEnd, marks ? mEnd - lineStart : Infinity)
		}
		let boundary = -1
		if (!clusters) {
			// Printable ASCII: one cell per char, column == offset.
			let start = Math.max(from, Math.ceil(colFrom - colShift)), end = Math.min(to, Math.ceil(colTo - colShift))
			if (rainbow) while (bi < brackets!.length && brackets![bi] < start) bi += 2
			for (let i = start; i < end; i++) {
				let col = i + colShift
				if (i >= boundary) {
					boundary = styleAt(i)
					this.decoRuns(col, cls, mark)
				}
				if (col >= this.next) this.advance(col)
				let st = styles[style], color = st.color
				if (rainbow && brackets![bi] == i) {
					color = rainbow[brackets![bi + 1]]
					bi += 2
				}
				let code = text.charCodeAt(i)
				if (bidi && mirrorChar(code) && this.rtlAt(col)) code = mirrorChar(code)
				let g = atlas.asciiGlyph(st.variant, code)
				if (g.w) pushGlyph(glyphs, (bidi ? this.xOf(col, 1) : col - this.rs + this.rx) * cw + g.ox, this.y + g.oy, g, color)
			}
			this.endCol = Math.max(this.endCol, end + colShift)
			return
		}
		for (let c of clusters) {
			if (c.to <= from) continue
			if (c.from >= to) break
			let col = c.col + colShift
			if (col + c.cells <= colFrom) continue
			if (col >= colTo) break
			if (c.from >= boundary) {
				boundary = styleAt(c.from)
				this.decoRuns(col, cls, mark)
			}
			if (col >= this.next) this.advance(col)
			this.endCol = Math.max(this.endCol, col + c.cells)
			if (c.kind == ClusterKind.Tab) continue
			let v = styles[style].variant, color = styles[style].color
			if (rainbow) {
				while (bi < brackets!.length && brackets![bi] < c.from) bi += 2
				if (brackets![bi] == c.from) color = rainbow[brackets![bi + 1]]
			}
			let ch = c.text.length == 1 ? c.text.charCodeAt(0) : -1
			// Rule L4: brackets drawn right-to-left are mirrored.
			if (bidi && ch >= 0 && mirrorChar(ch) && this.rtlAt(col)) ch = mirrorChar(ch)
			let g = c.kind == ClusterKind.Shaped ? atlas.shapedGlyph(v, c.text, c.cells)
				: ch >= 0 && ch < 128 ? atlas.asciiGlyph(v, ch)
				: atlas.glyph(v, ch >= 0 ? String.fromCharCode(ch) : c.text)
			if (g.w) pushGlyph(glyphs, (bidi ? this.xOf(col, c.cells) : col - this.rs + this.rx) * cw + g.ox, this.y + g.oy, g, color)
		}
	}

	endCol = 0

	/// A zero-width point mark (CodeMirror's lint points): a small
	/// triangle at the bottom of the line, centered on the position.
	point(p: Piece, color: string) {
		if (p.col < this.colFrom || p.col > this.colTo) return
		if (p.col >= this.next) this.advance(p.col)
		let g = this.host.pointGlyph(), dpr = this.host.dpr
		let x = this.xOf(p.col, 0) * this.cw - g.w / dpr / 2
		pushGlyph(this.glyphs, x, this.y + this.lh - g.h / dpr, g, parseColor(color))
	}

	/// A widget label (or replaced-range placeholder).
	label(p: Piece, style: ResolvedMark | null) {
		let host = this.host, atlas = host.atlas, label = p.label!
		if (p.col + p.cells <= this.colFrom || p.col >= this.colTo) return
		this.decoRuns(p.col, -1, -1)
		if (p.col >= this.next) this.advance(p.col)
		let x0 = this.xOf(p.col, p.cells) * this.cw, w = p.cells * this.cw, lh = this.lh, y = this.y
		let inner = x0 + (label.padLeft ?? 0) * this.cw
		if (label.draw) {
			// The widget's own drawing.
			let iw = (label.cells ?? p.cells - (label.padLeft ?? 0) - (label.padRight ?? 0)) * this.cw
			pushGlyph(this.glyphs, inner, y, host.widgetImage(label, iw, lh), 0)
			this.endCol = Math.max(this.endCol, p.col + p.cells)
			return
		}
		if (!label.text && label.cells) {
			// A box (color chips...): square-ish, centered on the line.
			let bw = label.cells * this.cw, bh = Math.min(lh - 4, bw), by = y + (lh - bh) / 2
			if (style?.rounded) {
				if (style.background != null) pushGlyph(this.glyphs, inner, by, host.roundedBox(bw, bh, false), style.background)
				if (style.border != null) pushGlyph(this.glyphs, inner, by, host.roundedBox(bw, bh, true), style.border)
			} else {
				if (style?.background != null) pushRect(this.rects, inner, by, bw, bh, style.background)
				if (style?.border != null) {
					pushRect(this.rects, inner, by, bw, 1, style.border)
					pushRect(this.rects, inner, by + bh - 1, bw, 1, style.border)
					pushRect(this.rects, inner, by, 1, bh, style.border)
					pushRect(this.rects, inner + bw - 1, by, 1, bh, style.border)
				}
			}
			this.endCol = Math.max(this.endCol, p.col + p.cells)
			return
		}
		if (style?.background != null) pushRect(this.rects, x0, y + 1, w, lh - 2, style.background)
		if (style?.border != null) {
			let b = style.border
			pushRect(this.rects, x0, y + 1, w, 1, b)
			pushRect(this.rects, x0, y + lh - 2, w, 1, b)
			pushRect(this.rects, x0, y + 1, 1, lh - 2, b)
			pushRect(this.rects, x0 + w - 1, y + 1, 1, lh - 2, b)
		}
		let base = host.styles[host.defaultStyle]
		let st = host.styles[host.styleFor(
			((style?.bold ? 1 : 0) | (style?.italic ? 2 : 0)) as FontVariant, style?.color ?? base.color)]
		let start = x0 + (label.padLeft ?? 0) * this.cw, text = label.text
		let clusters = host.layouts.get(text)
		if (!clusters) {
			for (let i = 0; i < text.length; i++) {
				let g = atlas.asciiGlyph(st.variant, text.charCodeAt(i))
				if (g.w) pushGlyph(this.glyphs, start + i * this.cw + g.ox, y + g.oy, g, st.color)
			}
		} else {
			for (let c of clusters) {
				if (c.kind == ClusterKind.Tab) continue
				let g = c.kind == ClusterKind.Shaped ? atlas.shapedGlyph(st.variant, c.text, c.cells) : atlas.glyph(st.variant, c.text)
				if (g.w) pushGlyph(this.glyphs, start + c.col * this.cw + g.ox, y + g.oy, g, st.color)
			}
		}
		this.endCol = Math.max(this.endCol, p.col + p.cells)
	}

	/// Track decoration rect runs; flush the previous one when the
	/// syntax class or mark changes at `col`.
	private decoRuns(col: number, cls: number, mark: number) {
		if (cls != this.synCls) {
			this.flushSyn(col)
			let d = cls >= 0 ? this.host.decoForClass(cls) : null
			if (d && (d.bg != null || d.underline || d.strike)) {
				this.synCls = cls
				this.synFrom = col
			}
		}
		if (mark != this.markId) {
			this.flushMark(col)
			let m = mark >= 0 ? this.host.decos.marks[mark] : null
			if (m && (m.background != null || m.underline || m.strike || m.border != null)) {
				this.markId = mark
				this.markFrom = col
			}
		}
	}

	private flushSyn(col: number) {
		if (this.synCls >= 0 && col > this.synFrom) {
			let d = this.host.decoForClass(this.synCls)!, lh = this.lh
			this.spans(this.synFrom, col, (x, y, w) => {
				if (d.bg != null) pushRect(this.rects, x, y, w, lh, d.bg)
				if (d.underline) pushRect(this.rects, x, y + lh - Math.max(1, lh * 0.12), w, 1, d.color)
				if (d.strike) pushRect(this.rects, x, y + lh * 0.5, w, 1, d.color)
			})
		}
		this.synCls = -1
	}

	private flushMark(col: number) {
		if (this.markId >= 0 && col > this.markFrom) {
			let m = this.host.decos.marks[this.markId], lh = this.lh
			let line = m.underlineColor ?? m.color ?? this.host.styles[this.host.defaultStyle].color
			this.spans(this.markFrom, col, (x, y, w) => {
				if (m.background != null) pushRect(this.rects, x, y, w, lh, m.background)
				if (m.underline == 1) pushRect(this.rects, x, y + lh - Math.max(1, Math.round(lh * 0.1)), w, 1, line)
				if (m.underline == 2) {
					let wave = this.host.waveGlyph(), cw = this.cw
					for (let wx = x; wx < x + w - 0.5; wx += cw) pushGlyph(this.glyphs, wx, y + lh - 3.5, wave, line)
				}
				if (m.strike) pushRect(this.rects, x, y + lh * 0.5, w, 1, line)
				if (m.border != null) {
					pushRect(this.rects, x, y, w, 1, m.border)
					pushRect(this.rects, x, y + lh - 1, w, 1, m.border)
				}
			})
		}
		this.markId = -1
	}

	/// Split columns `a..b` into drawn pieces (x, y, width in px): one
	/// per row, or per level run in bidi lines.
	private spans(a: number, b: number, f: (x: number, y: number, w: number) => void) {
		let vl = this.vl, cw = this.cw
		if (!vl.breaks && !vl.bidi) { f(a * cw, this.baseY, (b - a) * cw); return }
		this.lines.colSpans(vl, a, b, (r, x, w) => f(x * cw, this.baseY + r * this.lh, w * cw))
	}

	finish() {
		this.flushSyn(this.endCol)
		this.flushMark(this.endCol)
	}

	/// Whitespace markers for a visual line: a dot per space, an arrow per
	/// tab, trailing whitespace highlighted, a mark at the line end.
	whitespace(n: number, vl: VLine, ws: {color: PackedColor, trailing: PackedColor | null, spaces: boolean, lineBreaks: boolean}, doc: Text) {
		let host = this.host, atlas = host.atlas, lines = host.lines, cw = this.cw, lh = this.lh
		let variant = host.styles[host.defaultStyle].variant
		let place = (col: number, g: GlyphEntry, end = false) => {
			let r = end ? vl.rows - 1 : vl.breaks ? lines.rowAt(vl, lines.posAtCol(vl, col)) : 0
			let x = (end ? lines.rowRight(vl, r) : vl.bidi ? lines.boxX(vl, r, col, 1) : col - lines.rowStartCol(vl, r) + lines.rowX(vl, r)) * cw
			pushGlyph(this.glyphs, x + g.ox, this.baseY + r * lh + g.oy, g, ws.color)
		}
		let text = vl.text, trail = text.length
		while (trail > 0 && (text.charCodeAt(trail - 1) == 32 || text.charCodeAt(trail - 1) == 9)) trail--
		if (!vl.pieces) {
			if (ws.spaces) for (let i = 0; i < text.length; i++) {
				let c = text.charCodeAt(i)
				if (c != 32 && c != 9) continue
				let col = lines.colAt(vl, i)
				if (col < this.colFrom || col >= this.colTo) continue
				place(col, atlas.glyph(variant, c == 32 ? "\u00b7" : "\u2192"))
			}
			if (ws.trailing != null && trail < text.length && trail > 0) {
				let a = lines.colAt(vl, trail), b = lines.colAt(vl, text.length)
				lines.colSpans(vl, a, b, (r, x, w) => pushRect(this.rects, x * cw, this.baseY + r * lh, w * cw, lh, ws.trailing!))
			}
		}
		if (ws.lineBreaks && vl.last < doc.lines) place(vl.width, atlas.glyph(variant, "\u21b5"), true)
	}
}

/// Make glyph instances draw nothing (zero size).
function blankGlyphs(buf: InstanceBuffer, from: number, count: number) {
	if (!count) return
	for (let i = from; i < from + count; i++) buf.u32[i * GLYPH_STRIDE + 3] = 0
	buf.touch(from)
}

/// Make rect instances draw nothing (transparent; the shaders give
/// rects a 1px minimum size, so zeroing the size isn't enough).
function blankRects(buf: InstanceBuffer, from: number, count: number) {
	if (!count) return
	for (let i = from; i < from + count; i++) buf.u32[i * RECT_STRIDE + 4] = 0
	buf.touch(from)
}

export function sameRuns(a: LineRuns | null, b: LineRuns | null) {
	if (a === b) return true
	if (!a || !b || a.length != b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
	return true
}
