import type {ChangeDesc, Text} from "@codemirror/state"
import type {WidgetType} from "@codemirror/view"
import type {CanvasWidgetSpec, DecoState, PointDeco} from "./decorations"
import {autoLevel, bidiLevels, isBidiSpace, type LevelRun, reorderRuns, rtlChars, type Span} from "./bidi"
import {type Cluster, ClusterKind, type LineLayouts, retab, simpleLine, tabCells} from "./layout"
import {RowMap} from "./rowmap"

export const enum PieceKind { Text = 0, Widget = 1, Replace = 2 }

/// A piece of a visual line: text from one document line, an inline
/// widget, or a replaced range (with an optional widget label).
/// Positions are relative to the visual line's start.
export interface Piece {
	kind: PieceKind
	from: number
	to: number
	/// Start column in the (unwrapped) visual line, and width in cells.
	col: number
	cells: number
	/// Text pieces: the document line's text, its start (relative), and
	/// the layout column of `from` within that line.
	text: string
	lineStart: number
	colBase: number
	/// The line's clusters with tabs stopping at this piece's tab stops
	/// (see `VLine.layout`), or null when they're the document line's.
	layout: Cluster[] | null
	point: PointDeco | null
	label: CanvasWidgetSpec | null
}

/// What is drawn on one or more rows: a document line, or several
/// joined by replaced ranges spanning line breaks (folds).
export interface VLine {
	/// Document lines covered.
	first: number
	last: number
	/// Absolute document range.
	from: number
	to: number
	/// The first line's text.
	text: string
	/// `text`'s clusters when its tabs stop elsewhere than in the
	/// document line (null: `layouts.get(text)`). Like CodeMirror,
	/// whose tabs the browser stops at multiples of the tab size from
	/// the row's start, tabs stop at screen columns: after inline widgets
	/// and folds, after a block replace (its row starts at the edge),
	/// and on wrapped rows.
	layout: Cluster[] | null
	/// Null for the common case: a single line with no widgets or
	/// replaced ranges (columns come straight from the line layout).
	pieces: Piece[] | null
	/// Width in cells, unwrapped.
	width: number
	/// Unwrapped column and relative position where each row after the
	/// first starts (null: one row).
	breaks: number[] | null
	breakPos: number[] | null
	rows: number
	/// Indent (cells) of continuation rows.
	indent: number
	/// Block widgets drawn after the text rows (their own rows).
	blocks: {point: PointDeco, rows: number}[] | null
	blockRows: number
	/// A block replace covering the whole visual line: its widget's DOM
	/// fills `rows` (0 without a widget: the lines are hidden), and no
	/// text is drawn. Positions inside are hidden; the cursor stops at
	/// its start (drawn on the first row) and end (the last row).
	cover: PointDeco | null
	/// Block replaces starting or ending inside the visual line, like
	/// CodeMirror: the text before ends its row, the widget fills `rows`
	/// rows of its own (from `row`), and the text after starts a row of
	/// its own at the left edge.
	inner: {point: PointDeco, row: number, rows: number}[] | null
	/// Rows starting at the left edge whatever the continuation indent
	/// (a block replace's rows and the row after it).
	flush: number[] | null
	/// Bidi layout per row, null for the common case: a left-to-right
	/// paragraph without right-to-left text, where x follows columns.
	bidi: BidiRow[] | null
	/// The paragraph is right-to-left (its rows are right-aligned).
	rtl: boolean
}

/// The visual order of one row of a bidi visual line.
export interface BidiRow {
	/// Level runs in visual order: relative positions, unwrapped
	/// columns, and x (cells) from the row's left edge.
	runs: LevelRun[]
	/// x (cells) of the row's left edge: the continuation indent, or
	/// where a right-to-left row starts so that it ends at the right.
	x0: number
	width: number
}

/// Paragraph direction: left-to-right, right-to-left, or per line
/// from its first strong character ("auto", like CodeMirror's
/// `perLineTextDirection` and Ace's line-based RTL switching).
export type TextDirectionMode = "ltr" | "rtl" | "auto"

/// How wrapped continuation rows are indented (like VS Code's
/// `wrappingIndent`): not at all, like the line, one or two more tab
/// stops, or a number of extra columns past the line's indentation (a
/// small offset like 2 keeps continuations visibly apart).
export type WrapIndent = "none" | "same" | "indent" | "deepIndent" | number

export interface LineModelHost {
	readonly doc: Text
	readonly layouts: LineLayouts
	readonly decos: DecoState
	widgetSpec(widget: WidgetType): CanvasWidgetSpec
	/// Rows a block widget takes.
	blockRows(point: PointDeco): number
	/// Called with each laid-out visual line's width (cells), so the
	/// horizontal scroll range includes widgets.
	noteWidth?(cells: number): void
}

const MAX_CACHE = 3000

/// Maps document lines to visual lines and rows (line wrapping,
/// folding, inline widgets). Without wrapping or line-joining
/// decorations it's the identity (row = line - 1) and costs nothing.
export class LineModel {
	/// Null while rows are exactly lines.
	private map: RowMap | null = null
	private cache = new Map<number, VLine>()
	/// Wrap width in cells (0: no wrapping).
	wrap = 0
	/// Bumped whenever the row of any line may have changed.
	version = 0
	/// Some chunks may be unmeasured (cleared by `measureIdle`).
	dirty = false
	/// Continuation row indentation.
	wrapIndent: WrapIndent = "same"
	private lastJoins: number[] = []
	private hadBlocks = false
	/// Paragraph direction.
	direction: TextDirectionMode = "ltr"
	/// Width (cells) right-to-left rows align to when not wrapping.
	alignCols = 0
	/// Bumped when bidi layout changes for reasons other than the text.
	bidiVersion = 0
	private spanCache = new Map<string, Span[]>()

	constructor(private host: LineModelHost) {}

	get identity() { return !this.map }

	/// Set the wrap width (cells, 0 = off) and continuation indent.
	/// Returns whether anything changed.
	setWrap(cols: number, indent: WrapIndent = this.wrapIndent) {
		cols = Math.max(0, Math.floor(cols))
		if (cols == this.wrap && indent == this.wrapIndent) return false
		this.wrap = cols
		this.wrapIndent = indent
		this.cache.clear()
		this.syncMode(true)
		return true
	}

	/// Set the paragraph direction and the width right-to-left rows
	/// align to. Returns whether drawn lines changed.
	setDirection(direction: TextDirectionMode, alignCols: number) {
		let changed = false
		alignCols = Math.max(0, Math.floor(alignCols))
		if (direction != this.direction) {
			this.direction = direction
			this.cache.clear()
			this.spanCache.clear()
			changed = true
		}
		if (alignCols != this.alignCols) {
			this.alignCols = alignCols
			// Only right-to-left paragraphs depend on the width.
			if (this.direction != "ltr") {
				for (let [k, vl] of this.cache) if (vl.rtl) this.cache.delete(k)
				changed = true
			}
		}
		if (changed) {
			this.bidiVersion++
			this.version++
		}
		return changed
	}

	/// Paragraph level of a line (0: left-to-right, 1: right-to-left).
	baseLevel(text: string) {
		let dir = this.direction
		return dir == "ltr" ? 0 : dir == "rtl" ? 1 : simpleLine.test(text) ? 0 : autoLevel(text)
	}

	/// Switch between identity and mapped mode as needed. `remeasure`
	/// invalidates every count.
	private syncMode(remeasure = false) {
		let need = this.wrap > 0 || this.host.decos.joins.length > 0 || this.host.decos.blockCount > 0
		if (!need) {
			if (this.map) { this.map = null; this.version++ }
			return
		}
		if (!this.wrap && !this.host.decos.blockCount) {
			// Without wrapping or blocks, rows only depend on joins: build directly.
			this.rebuildNoWrap()
			return
		}
		if (!this.map) {
			this.map = new RowMap(this.host.doc.lines)
			this.version++
		} else if (this.map.lines != this.host.doc.lines) {
			// A new state (setState) can have any number of lines.
			this.map.rebuild(this.host.doc.lines)
			this.version++
		} else if (remeasure) {
			this.map.invalidateAll()
			this.version++
		}
		this.dirty = true
	}

	private rebuildNoWrap() {
		let doc = this.host.doc, joins = this.host.decos.joins
		let map = this.map ??= new RowMap(0)
		map.rebuild(doc.lines, true)
		for (let i = 0; i < joins.length; i += 2)
			map.fill(doc.lineAt(joins[i]).number + 1, doc.lineAt(joins[i + 1]).number, 0)
		this.version++
	}

	get totalRows() { return this.map ? this.map.totalRows : this.host.doc.lines }

	private head: {point: PointDeco, rows: number}[] | null | undefined = undefined

	/// Block widgets before line 1. They have no line above to follow,
	/// so they're drawn above the rows, in a head that pushes row 0 down
	/// (row numbering doesn't change, so neither does the scene).
	get headBlocks() {
		if (this.head === undefined) {
			let found = this.host.decos.blockCount ? this.blockBefore(1) : null
			this.head = found && found.map(point => ({point, rows: this.host.blockRows(point)}))
		}
		return this.head
	}

	/// Rows taken by `headBlocks`.
	get headRows() {
		let head = this.headBlocks, rows = 0
		if (head) for (let b of head) rows += b.rows
		return rows
	}

	/// First line of the visual line containing line `n`.
	vlineStart(n: number) {
		let decos = this.host.decos
		if (!decos.joins.length) return n
		let doc = this.host.doc
		for (;;) {
			let j = decos.joinAt(doc.line(n).from)
			if (j < 0) return n
			n = doc.lineAt(decos.joins[j * 2]).number
		}
	}

	/// The block replace drawn on row `r` of a visual line, if any.
	innerAt(vl: VLine, r: number) {
		if (vl.inner) for (let b of vl.inner) if (r >= b.row && r < b.row + b.rows) return b
		return null
	}

	/// The first row of a visual line with text (where its line number
	/// goes, like CodeMirror) and the document line it starts: after a
	/// block replace at its start, the line its end is on.
	textRow(vl: VLine): {row: number, line: number} {
		let b = vl.inner?.[0]
		if (!b || b.row > 0 || b.point.from > vl.from) return {row: 0, line: vl.first}
		return {row: b.rows, line: this.host.doc.lineAt(b.point.to).number}
	}

	/// Whether line `n` starts a visual line drawn as a block replace's
	/// widget (no text, line number or gutter markers).
	covered(n: number) {
		return this.host.decos.coverCount > 0 && !this.hidden(n) && this.vline(n).cover != null
	}

	/// Whether line `n` is hidden inside a visual line starting above.
	hidden(n: number) {
		let decos = this.host.decos
		return decos.joins.length > 0 && decos.joinAt(this.host.doc.line(n).from) >= 0
	}

	/// 0-based row where the visual line containing `n` starts.
	rowOf(n: number) {
		if (!this.map) return n - 1
		return this.map.rowsBefore(this.vlineStart(n))
	}

	/// The visual line (by first doc line) at a 0-based row, and the row it starts at.
	lineAtRow(row: number): {line: number, rowStart: number} {
		if (!this.map) {
			let line = Math.max(1, Math.min(this.host.doc.lines, Math.floor(row) + 1))
			return {line, rowStart: line - 1}
		}
		return this.map.lineAtRow(Math.floor(row))
	}

	/// Rows taken by the visual line starting at `n` (as currently
	/// counted, which may be an estimate until measured).
	rowsAt(n: number) { return this.map ? this.map.count(n) : 1 }

	/// The visual line containing line `n`.
	vline(n: number): VLine {
		let start = this.vlineStart(n)
		let found = this.cache.get(start)
		if (found) return found
		if (this.cache.size > MAX_CACHE) this.cache.clear()
		found = this.build(start)
		this.cache.set(start, found)
		return found
	}

	/// After a document change: drop or shift cached visual lines and
	/// splice the row counts of changed lines.
	mapChanges(changes: ChangeDesc, startDoc: Text, doc: Text) {
		this.head = undefined
		if (this.cache.size) {
			let next = new Map<number, VLine>()
			for (let vl of this.cache.values()) {
				if (changes.touchesRange(vl.from, vl.to)) continue
				let from = changes.mapPos(vl.from)
				let delta = from - vl.from
				vl.from = from
				vl.to += delta
				let first = doc.lineAt(from).number, dl = first - vl.first
				vl.first = first
				vl.last += dl
				next.set(first, vl)
			}
			this.cache = next
		}
		if (this.map) {
			let ranges: number[] = []
			changes.iterChangedRanges((fromA, toA, fromB, toB) => {
				ranges.push(startDoc.lineAt(fromA).number, startDoc.lineAt(toA).number, doc.lineAt(fromB).number, doc.lineAt(toB).number)
			})
			for (let i = ranges.length - 4; i >= 0; i -= 4)
				this.map.splice(ranges[i], ranges[i + 1] - ranges[i] + 1, ranges[i + 3] - ranges[i + 2] + 1)
			this.version++
			this.dirty = true
		}
	}

	/// Layout-affecting decorations changed in these (new-document)
	/// ranges, given as flat [from, to] pairs.
	invalidate(ranges: readonly number[]) {
		if (!ranges.length) return
		this.head = undefined
		let doc = this.host.doc
		for (let [k, vl] of this.cache)
			for (let i = 0; i < ranges.length; i += 2)
				if (vl.from <= ranges[i + 1] && vl.to >= ranges[i]) { this.cache.delete(k); break }
		let joins = this.host.decos.joins
		let joinsChanged = joins.length != this.lastJoins.length || joins.some((v, i) => v != this.lastJoins[i])
		this.lastJoins = joins.slice()
		let blocks = this.host.decos.blockCount > 0
		if (blocks != this.hadBlocks) {
			this.hadBlocks = blocks
			this.syncMode(true)
		} else if (!this.wrap && !blocks) {
			if (joinsChanged) this.syncMode()
		} else if (!this.map) {
			this.syncMode()
		} else {
			let map = this.map
			for (let i = 0; i < ranges.length; i += 2) {
				// Joins may start or end anywhere in the range; extend to the
				// visual lines around it.
				let a = Math.max(1, this.vlineStart(doc.lineAt(Math.min(ranges[i], doc.length)).number) - 1)
				let b = Math.min(doc.lines, doc.lineAt(Math.min(ranges[i + 1], doc.length)).number + 1)
				if (b - a > 400) {
					map.invalidate(a, b)
					this.dirty = true
					continue
				}
				// Small ranges (widgets appearing as plugins follow the
				// viewport): recount just these lines now, instead of a
				// whole chunk on the next frame.
				let pos = doc.line(a).from, iter = doc.iterLines(a, b + 1)
				for (let n = a; n <= b; n++) {
					let text = iter.next().value
					map.set(n, this.lineRows(n, text, pos))
					pos += text.length + 1
				}
			}
		}
		this.version++
	}

	/// The measured rows, to give back with `restoreRows` when a later
	/// state shows the same document (switching editor tabs), so scroll
	/// positions map to the same lines. Null in identity mode.
	saveRows(): RowMap | null {
		if (!this.map) return null
		let saved = this.map.clone()
		// Lines with decorations may lay out differently in the next state.
		this.invalidateDecorated(saved)
		return saved
	}

	/// Restore rows saved for this document (same line count and layout
	/// settings). Counts stay as saved, so rows and heights match what
	/// they were; lines with decorations get measured again.
	restoreRows(saved: RowMap) {
		if (!this.map || saved.lines != this.host.doc.lines) return false
		this.map.copyFrom(saved)
		this.invalidateDecorated(this.map)
		this.cache.clear()
		this.head = undefined
		this.dirty = true
		this.version++
		return true
	}

	private invalidateDecorated(map: RowMap) {
		let doc = this.host.doc, decos = this.host.decos
		let lineOf = (pos: number) => doc.lineAt(Math.min(pos, doc.length)).number
		for (let p of decos.points) map.invalidate(lineOf(p.from), lineOf(p.to) + 1)
		let joins = decos.joins
		for (let i = 0; i < joins.length; i += 2) map.invalidate(lineOf(joins[i]), lineOf(joins[i + 1]))
	}

	/// Drop all cached layout (font, tab size or decoration styles changed).
	reset() {
		this.cache.clear()
		this.head = undefined
		this.syncMode(true)
		this.version++
	}

	/// Measure the chunks covering lines `a`..`b`. Returns the change in
	/// rows above line `anchor` (for scroll anchoring) and in total.
	measure(a: number, b: number, anchor: number): {above: number, total: number} {
		let map = this.map, res = {above: 0, total: 0}
		if (!map) return res
		let lines = this.host.doc.lines
		let from = map.chunkOf(Math.max(1, a)), to = map.chunkOf(Math.min(lines, b))
		for (let c = from; c <= to; c++) {
			if (map.isValid(c)) continue
			let {first, len} = map.chunkLines(c)
			let before = anchor > first ? map.rowsBefore(anchor) : 0
			let delta = this.measureChunk(c)
			if (delta) {
				res.total += delta
				if (anchor >= first + len) res.above += delta
				else if (anchor > first) res.above += map.rowsBefore(anchor) - before
				this.version++
			}
		}
		return res
	}

	/// Measure invalid chunks outward from line `around` until
	/// `deadline`. Returns the row change above `anchor` and whether
	/// unmeasured chunks remain.
	measureIdle(around: number, anchor: number, deadline: number) {
		let map = this.map, res = {above: 0, total: 0, done: true}
		if (!map) { this.dirty = false; return res }
		let center = map.chunkOf(around), n = map.chunkCount
		for (let d = 0; d < n * 2; d++) {
			let c = d % 2 ? center + (d + 1) / 2 : center - d / 2
			if (c < 0 || c >= n || map.isValid(c)) continue
			if (performance.now() > deadline) { res.done = false; break }
			let {first, len} = map.chunkLines(c)
			let m = this.measure(first, first + len - 1, anchor)
			res.above += m.above
			res.total += m.total
		}
		if (res.done) this.dirty = false
		return res
	}

	private measureChunk(c: number) {
		let map = this.map!, host = this.host, doc = host.doc, decos = host.decos
		let {first, len} = map.chunkLines(c)
		let pos = doc.line(first).from
		let texts: string[] = []
		for (let iter = doc.iterLines(first, first + len); !iter.next().done;) texts.push(iter.value)
		return map.measure(c, n => {
			let text = texts[n - first], from = pos
			pos += text.length + 1
			return this.lineRows(n, text, from)
		})
	}

	private scratch: PointDeco[] = []

	/// Rows for line `n` (0 when hidden in a visual line above).
	private lineRows(n: number, text: string, from: number) {
		let decos = this.host.decos, wrap = this.wrap
		if (decos.joins.length && decos.joinAt(from) >= 0) return 0
		if (decos.points.length) {
			this.scratch.length = 0
			// Points on the line, or a block widget before the next line.
			let end = from + text.length
			if (decos.pointsIn(from, end, this.scratch).length ||
				decos.blockCount && n < this.host.doc.lines && this.blockBefore(n + 1)) {
				let vl = this.vline(n)
				return vl.rows + vl.blockRows
			}
		}
		if (!wrap) return 1
		if (simpleLine.test(text)) return asciiRows(text, wrap, this.indentOf(text))
		return this.vline(n).rows
	}

	private build(n: number): VLine {
		let {doc, decos, layouts} = this.host
		let line = doc.line(n), from = line.from, to = line.to, last = n
		// Extend over joins starting on the (last) line.
		if (decos.joins.length) {
			for (let j = decos.joins, i = 0; i < j.length; i += 2) {
				if (j[i] > to) break
				if (j[i] >= from && j[i + 1] > to) {
					let end = doc.lineAt(j[i + 1])
					to = end.to
					last = end.number
				}
			}
		}
		let all = decos.points.length ? decos.pointsIn(from, to) : []
		let points = decos.blockCount ? all.filter(p => !p.block) : all
		let vl: VLine = {first: n, last, from, to, text: line.text, layout: null, pieces: null, width: 0, breaks: null, breakPos: null, rows: 1, indent: 0,
			blocks: null, blockRows: 0, cover: null, inner: null, flush: null, bidi: null, rtl: false}
		if (decos.blockCount) {
			// Blocks after this visual line, then those before the next line.
			// Those before line 1 are the head (`headBlocks`).
			let blocks = all.filter(p => p.block && p.side > 0)
			if (last < doc.lines) blocks = blocks.concat(this.blockBefore(last + 1) ?? [])
			if (blocks.length) {
				vl.blocks = blocks.map(point => ({point, rows: this.host.blockRows(point)}))
				vl.blockRows = vl.blocks.reduce((s, b) => s + b.rows, 0)
			}
		}
		let cover = decos.coverCount ? all.find(p => p.blockReplace && p.from == from && p.to == to) : null
		if (cover) {
			let widget = cover.deco.spec.widget as WidgetType | undefined
			vl.cover = cover
			vl.rows = widget ? this.host.blockRows(cover) : 0
			vl.pieces = [{kind: PieceKind.Replace, from: 0, to: to - from, col: 0, cells: 0, text: "", lineStart: 0, colBase: 0,
				layout: null, point: cover, label: null}]
			return vl
		}
		if (!points.length && last == n) {
			vl.width = layouts.width(line.text)
		} else {
			vl.pieces = this.buildPieces(from, to, points)
			let lastPiece = vl.pieces[vl.pieces.length - 1]
			vl.width = lastPiece ? lastPiece.col + lastPiece.cells : 0
		}
		this.host.noteWidth?.(vl.width)
		let inner = decos.coverCount > 0 && vl.pieces != null && vl.pieces.some(p => p.point?.blockReplace)
		if (inner || this.wrap && vl.width > this.wrap) {
			let breaks: number[] = [], breakPos: number[] = []
			let indent = vl.indent = this.wrap ? this.indentOf(vl.text) : 0
			if (!vl.pieces && simpleLine.test(vl.text)) asciiBreaks(vl.text, this.wrap, breaks, indent)
			else unitBreaks(vl, layouts, this.wrap || Infinity, indent, breaks, breakPos, p => this.host.blockRows(p))
			if (breaks.length) {
				vl.breaks = breaks
				vl.breakPos = breakPos.length ? breakPos : breaks.slice()
				vl.rows = breaks.length + 1
			}
		}
		this.buildBidi(vl)
		return vl
	}

	/// Bidi layout of a visual line: resolve levels per document line
	/// (UAX #9), then per row (lines are reordered after wrapping, rule
	/// L1 and L2) merge layout units into level runs in visual order.
	/// Skipped (the common case) for left-to-right paragraphs without
	/// right-to-left text.
	private buildBidi(vl: VLine) {
		let base = this.baseLevel(vl.text)
		if (!base) {
			let rtl = false
			if (!vl.pieces) rtl = !simpleLine.test(vl.text) && rtlChars.test(vl.text)
			else for (let p of vl.pieces) if (p.kind == PieceKind.Text && !simpleLine.test(p.text) && rtlChars.test(p.text)) { rtl = true; break }
			if (!rtl) return
		}
		let u = new Units()
		if (!vl.pieces) {
			u.text(vl.text, clustersOf(this.host.layouts, vl), bidiLevels(vl.text, base), 0, 0, vl.text.length, 0)
		} else {
			let levels: Uint8Array | null = null, lineStart = -1
			for (let p of vl.pieces) {
				if (p.kind == PieceKind.Text) {
					if (p.lineStart != lineStart || !levels) {
						lineStart = p.lineStart
						levels = bidiLevels(p.text, base)
					}
					u.text(p.text, clustersOf(this.host.layouts, p), levels, p.lineStart, p.from - p.lineStart, p.to - p.lineStart, p.col - p.colBase)
				} else {
					u.push(p.from, p.to, p.col, p.cells, -1, 0)
				}
			}
			u.resolveNeutral(base)
		}
		let rows: BidiRow[] = [], align = this.wrap || this.alignCols
		for (let r = 0, i = 0; r < vl.rows; r++) {
			let end = this.rowEndCol(vl, r) - 1e-6, start = i, last = r == vl.rows - 1
			while (i < u.length && (last || u.col[i] < end)) i++
			let runs = u.runs(start, i, base)
			let width = reorderRuns(runs)
			let x0 = base ? Math.max(0, align - width - this.rowX(vl, r)) : this.rowX(vl, r)
			rows.push({runs, x0, width})
		}
		vl.bidi = rows
		vl.rtl = base == 1
	}

	/// Bidi spans (CodeMirror `BidiSpan`s: level runs in visual order
	/// from the line's start side, so right to left in a right-to-left
	/// paragraph; line-relative) of a document line, ignoring wrapping
	/// like CodeMirror does. Used for visual cursor motion.
	lineSpans(text: string): Span[] {
		let base = this.baseLevel(text)
		if (!base && (simpleLine.test(text) || !rtlChars.test(text))) return [{from: 0, to: text.length, level: 0}]
		let key = base + text, found = this.spanCache.get(key)
		if (found) return found
		if (this.spanCache.size > 500) this.spanCache.clear()
		let u = new Units()
		u.text(text, this.host.layouts.get(text), bidiLevels(text, base), 0, 0, text.length, 0)
		let runs = u.runs(0, u.length, base)
		reorderRuns(runs)
		if (base) runs.reverse()
		found = runs.length ? runs.map(r => ({from: r.from, to: r.to, level: r.level})) : [{from: 0, to: 0, level: base}]
		this.spanCache.set(key, found)
		return found
	}

	private buildPieces(from: number, to: number, points: PointDeco[]) {
		let {doc, layouts} = this.host
		// `origin`: the column rows start at (after a block replace, whose
		// next row starts at the edge), so tab stops are counted from.
		let pieces: Piece[] = [], col = 0, pos = from, origin = 0
		let text = (a: number, b: number) => {
			// Text can't cross a line break here: line breaks inside a
			// visual line are always replaced.
			while (a <= b) {
				let line = doc.lineAt(a), end = Math.min(b, line.to)
				let clusters = layouts.get(line.text), layout: Cluster[] | null = null
				let colBase = layouts.columnAt(line.text, a - line.from, clusters)
				// Text after a widget or a fold: its tabs stop at screen columns.
				if (clusters && col - origin != colBase && line.text.indexOf("\t", a - line.from) >= 0) {
					let moved = retab(clusters, a - line.from, col - origin - colBase, layouts.tabSize)
					if (moved != clusters) layout = moved
				}
				let cells = layouts.columnAt(line.text, end - line.from, layout ?? clusters) - colBase
				pieces.push({kind: PieceKind.Text, from: a - from, to: end - from, col, cells, text: line.text,
					lineStart: line.from - from, colBase, layout, point: null, label: null})
				col += cells
				if (end >= b) break
				a = end + 1
			}
		}
		for (let p of points) {
			if (p.from < pos || p.from > to) continue
			text(pos, p.from)
			let widget = (p.deco.spec.widget as WidgetType | undefined) ?? null
			// A block replace's widget is drawn in rows of its own.
			let label = widget && !p.blockReplace ? this.host.widgetSpec(widget) : null
			let cells = label ? (label.cells ?? layouts.width(label.text)) + (label.padLeft ?? 0) + (label.padRight ?? 0) : 0
			let isReplace = (p.deco as any).isReplace
			pieces.push({kind: isReplace ? PieceKind.Replace : PieceKind.Widget, from: p.from - from, to: p.to - from, col, cells,
				text: "", lineStart: 0, colBase: 0, layout: null, point: p, label})
			col += cells
			if (p.blockReplace) origin = col
			pos = isReplace ? p.to : p.from
		}
		text(pos, to)
		return pieces
	}

	/// Continuation indent (cells) for a line's text.
	indentOf(text: string) {
		return wrapIndentColumns(text, this.host.layouts.tabSize, Math.floor(this.wrap / 2), this.wrapIndent)
	}

	/// Block widgets placed before line `n` (drawn after the line above).
	private blockBefore(n: number): PointDeco[] | null {
		let line = this.host.doc.line(n)
		let found = this.host.decos.pointsIn(line.from, line.to).filter(p => p.block && p.side < 0)
		return found.length ? found : null
	}

	// ---- Geometry inside a visual line (columns in cells) ----------------

	/// Unwrapped column of relative position `pos`. Like CodeMirror (and
	/// VS Code), a position sits after the inline widgets placed before
	/// it (`side: -1`) and before those placed after it, whatever its own
	/// side: a widget is never a cursor stop of its own. `side` < 0 binds
	/// to the text before a replaced range.
	colAt(vl: VLine, pos: number, side = 1): number {
		let layouts = this.host.layouts
		if (!vl.pieces) return layouts.columnAt(vl.text, pos, clustersOf(layouts, vl))
		let ps = vl.pieces
		for (let i = 0; i < ps.length; i++) {
			let p = ps[i]
			if (p.kind == PieceKind.Text) {
				if (pos < p.from) return p.col
				if (pos < p.to || pos == p.to && !nextAt(ps, i, pos, side)) {
					return p.col + layouts.columnAt(p.text, pos - p.lineStart, clustersOf(layouts, p)) - p.colBase
				}
			} else if (p.kind == PieceKind.Widget) {
				// A widget drawn after the position: the position sits before it.
				if (pos < p.from || pos == p.from && p.point!.side > 0) return p.col
			} else {
				if (pos <= p.from) return p.col
				if (pos < p.to) return side < 0 ? p.col : p.col + p.cells
			}
		}
		return vl.width
	}

	/// Relative position nearest unwrapped column `col`.
	posAtCol(vl: VLine, col: number): number {
		let layouts = this.host.layouts
		if (!vl.pieces) return layouts.offsetAtColumn(vl.text, col, clustersOf(layouts, vl))
		let ps = vl.pieces
		for (let p of ps) {
			if (col >= p.col + p.cells && p !== ps[ps.length - 1]) continue
			if (p.kind == PieceKind.Text) {
				let off = layouts.offsetAtColumn(p.text, col - p.col + p.colBase, clustersOf(layouts, p)) + p.lineStart
				return Math.max(p.from, Math.min(p.to, off))
			}
			if (p.kind == PieceKind.Widget) return p.from
			return col < p.col + p.cells / 2 ? p.from : p.to
		}
		return vl.to - vl.from
	}

	/// Row (within the visual line) of relative position `pos`.
	rowAt(vl: VLine, pos: number, side = 1) {
		let bp = vl.breakPos
		if (!bp) return 0
		let r = 0
		while (r < bp.length && (pos > bp[r] || pos == bp[r] && side >= 0)) r++
		return r
	}

	rowStartCol(vl: VLine, r: number) { return r && vl.breaks ? vl.breaks[r - 1] : 0 }
	/// x (cells) where row `r`'s content starts (continuation indent).
	rowX(vl: VLine, r: number) { return r && !vl.flush?.includes(r) ? vl.indent : 0 }
	rowEndCol(vl: VLine, r: number) { return vl.breaks && r < vl.breaks.length ? vl.breaks[r] : vl.width }

	/// Calls `f` with the row spans `[r0, r1)` of a visual line that an
	/// indent guide at column `col` crosses. Like VS Code, a guide never
	/// crosses text: continuation rows starting left of it (the indent
	/// capped at half the width, "none", rows after a block replace)
	/// block it.
	guideRows(vl: VLine, col: number, f: (r0: number, r1: number) => void) {
		if (vl.rows <= 1 || col >= vl.indent) return f(0, Math.min(1, vl.rows))
		let flush = vl.flush
		if (!flush) return f(0, vl.rows)
		let start = 0
		for (let r = 1; r <= vl.rows; r++) {
			if (r < vl.rows && !flush.includes(r)) continue
			if (r > start) f(start, r)
			start = r + 1
		}
	}

	/// Row and x (cells from the row start) of relative position `pos`.
	/// In bidi lines, a position where runs meet is drawn on the run
	/// `side` binds to (0: the lower level), like CodeMirror.
	coordsIn(vl: VLine, pos: number, side = 1) {
		if (vl.cover) return {row: pos > 0 ? Math.max(0, vl.rows - 1) : 0, x: 0}
		// A block replace's start binding forward is drawn on its first
		// row, its end binding backward on its last (CodeMirror draws them
		// at the widget's edges); inside, positions are hidden.
		if (vl.inner) for (let b of vl.inner) {
			let from = b.point.from - vl.from, to = b.point.to - vl.from
			if (b.rows && (pos == from && side >= 0 || pos > from && pos < to)) return {row: b.row, x: 0}
			if (b.rows && pos == to && side < 0) return {row: b.row + b.rows - 1, x: 0}
		}
		let r = this.rowAt(vl, pos, side)
		let col = this.colAt(vl, pos, side)
		if (vl.bidi) {
			let row = vl.bidi[r], run = runAt(row, pos, side)
			if (!run) return {row: r, x: vl.rtl ? row.x0 + row.width : row.x0}
			// A side pointing out of the line puts the line's start or end
			// at its visual edge (CodeMirror's `moveVisually` uses this for
			// text running against the paragraph direction there).
			if (side > 0 && pos == vl.to - vl.from || side < 0 && pos == 0)
				return {row: r, x: (side > 0) == !vl.rtl ? row.x0 + row.width : row.x0}
			col = Math.max(run.colFrom, Math.min(run.colTo, col))
			return {row: r, x: row.x0 + run.x + (run.level & 1 ? run.colTo - col : col - run.colFrom)}
		}
		return {row: r, x: col - this.rowStartCol(vl, r) + this.rowX(vl, r)}
	}

	/// The unwrapped column drawn at x (cells) on row `r`, and the level
	/// run there (bidi lines).
	colAtX(vl: VLine, r: number, x: number): {col: number, run: LevelRun | null} {
		if (!vl.bidi) return {col: this.rowStartCol(vl, r) + x - this.rowX(vl, r), run: null}
		let row = vl.bidi[r], runs = row.runs
		if (!runs.length) return {col: this.rowStartCol(vl, r), run: null}
		let lx = x - row.x0, run = runs[0]
		for (let i = 0; i < runs.length; i++) {
			run = runs[i]
			if (lx < run.x + run.colTo - run.colFrom) break
		}
		let off = Math.max(0, Math.min(run.colTo - run.colFrom, lx - run.x))
		return {col: run.level & 1 ? run.colTo - off : run.colFrom + off, run}
	}

	/// x (cells from the row start) of the left edge of a layout unit at
	/// column `col`, `cells` wide, on row `r` of a bidi line.
	boxX(vl: VLine, r: number, col: number, cells: number) {
		let row = vl.bidi![r], found = this.runAtCol(vl, r, col)
		if (!found) return row.x0
		return row.x0 + found.x + (found.level & 1 ? found.colTo - col - cells : col - found.colFrom)
	}

	/// The level run drawing the unit at column `col` on row `r` of a
	/// bidi line.
	runAtCol(vl: VLine, r: number, col: number) {
		let found: LevelRun | null = null
		for (let run of vl.bidi![r].runs) {
			if (col >= run.colFrom - 1e-6 && col < run.colTo - 1e-6) return run
			if (!found && Math.abs(col - run.colTo) < 1e-6) found = run
		}
		return found
	}

	/// x (cells) of the right end of row `r`'s text.
	rowRight(vl: VLine, r: number) {
		if (vl.bidi) return vl.bidi[r].x0 + vl.bidi[r].width
		return this.rowEndCol(vl, r) - this.rowStartCol(vl, r) + this.rowX(vl, r)
	}

	/// Call `f(row, x, width)` (cells) for each drawn piece of unwrapped
	/// columns `a..b`: one per row, or one per level run in bidi lines.
	colSpans(vl: VLine, a: number, b: number, f: (r: number, x: number, w: number) => void) {
		let r = 0, breaks = vl.breaks
		if (breaks) while (r < breaks.length && breaks[r] <= a) r++
		for (; a < b && r < vl.rows; r++) {
			let rs = this.rowStartCol(vl, r), end = Math.min(b, breaks && r < breaks.length ? breaks[r] : Infinity)
			if (!vl.bidi) {
				f(r, a - rs + this.rowX(vl, r), end - a)
			} else {
				let row = vl.bidi[r]
				for (let run of row.runs) {
					let lo = Math.max(a, run.colFrom), hi = Math.min(end, run.colTo)
					if (hi > lo) f(r, row.x0 + run.x + (run.level & 1 ? run.colTo - hi : lo - run.colFrom), hi - lo)
				}
			}
			a = end
		}
	}

	/// The unwrapped columns drawn between x1 and x2 (cells) on row `r`
	/// (bidi lines map visual windows to logical ones).
	colWindow(vl: VLine, r: number, x1: number, x2: number) {
		if (!vl.bidi) {
			let shift = this.rowStartCol(vl, r) - this.rowX(vl, r)
			return {from: x1 + shift, to: x2 + shift}
		}
		let row = vl.bidi[r], from = Infinity, to = -Infinity
		for (let run of row.runs) {
			let lo = Math.max(x1 - row.x0, run.x), hi = Math.min(x2 - row.x0, run.x + run.colTo - run.colFrom)
			if (hi < lo) continue
			let a = run.level & 1 ? run.colTo - (hi - run.x) : run.colFrom + (lo - run.x)
			let b = run.level & 1 ? run.colTo - (lo - run.x) : run.colFrom + (hi - run.x)
			from = Math.min(from, a)
			to = Math.max(to, b)
		}
		return from > to ? {from: 0, to: 0} : {from, to}
	}

	/// Relative position at x (cells) on row `r`, and the side it binds to.
	posInRow(vl: VLine, r: number, x: number): {pos: number, side: number} {
		// A block replace: its start in the upper half, its end below.
		if (vl.cover) return r < vl.rows / 2 ? {pos: 0, side: 1} : {pos: vl.to - vl.from, side: -1}
		let b = this.innerAt(vl, r)
		if (b) return r - b.row < b.rows / 2 ? {pos: b.point.from - vl.from, side: 1} : {pos: b.point.to - vl.from, side: -1}
		if (vl.bidi) {
			let {col, run} = this.colAtX(vl, r, x)
			if (!run) return {pos: r && vl.breakPos ? vl.breakPos[r - 1] : 0, side: 0}
			let pos = Math.max(run.from, Math.min(run.to, this.posAtCol(vl, col)))
			// Bind to the run drawn here when runs meet at the position.
			return {pos, side: run.to == run.from ? 0 : pos == run.to ? -1 : pos == run.from ? 1 : 0}
		}
		let start = this.rowStartCol(vl, r), end = this.rowEndCol(vl, r)
		let col = Math.max(start, Math.min(end, start + x - this.rowX(vl, r)))
		let pos = this.posAtCol(vl, col)
		let bp = vl.breakPos
		if (bp) {
			if (r > 0 && pos < bp[r - 1]) pos = bp[r - 1]
			if (r < bp.length && pos >= bp[r]) return {pos: bp[r], side: -1}
		}
		return {pos, side: 0}
	}
}

/// The run of a bidi row holding relative position `pos`. Where runs
/// meet, `side` picks the one before (< 0) or after (> 0) the
/// position, and 0 the lower level (CodeMirror's `BidiSpan.find`).
function runAt(row: BidiRow, pos: number, side: number) {
	let best: LevelRun | null = null
	for (let run of row.runs) {
		if (run.from > pos || run.to < pos) continue
		if (!best || (side < 0 ? run.from < pos && !(best.from < pos) : side > 0 ? run.to > pos && !(best.to > pos) : run.level < best.level))
			best = run
	}
	return best
}

/// The clusters a visual line's or a text piece's text is drawn with
/// (null: printable ASCII).
export function clustersOf(layouts: LineLayouts, x: {text: string, layout: Cluster[] | null}) {
	return x.layout ?? layouts.get(x.text)
}

/// Layout units of a visual line in logical order, with their bidi
/// levels, merged into level runs per row. Flat typed arrays, reused
/// across lines (bidi layout happens one line at a time).
class Units {
	static from = new Int32Array(256)
	static to = new Int32Array(256)
	static col = new Float64Array(256)
	static cells = new Float64Array(256)
	/// Level, or -1 for a neutral (widget) still to resolve.
	static level = new Int16Array(256)
	/// 1: whitespace, 2: tab (segment separator); rule L1 resets them.
	static space = new Uint8Array(256)
	length = 0
	get col() { return Units.col }

	push(from: number, to: number, col: number, cells: number, level: number, space: number) {
		let n = this.length++
		if (n == Units.from.length) Units.grow()
		Units.from[n] = from
		Units.to[n] = to
		Units.col[n] = col
		Units.cells[n] = cells
		Units.level[n] = level
		Units.space[n] = space
	}

	private static grow() {
		let size = Units.from.length * 2
		let copy = <A extends Int32Array | Float64Array | Int16Array | Uint8Array>(a: A, make: (n: number) => A) => {
			let b = make(size)
			b.set(a)
			return b
		}
		Units.from = copy(Units.from, n => new Int32Array(n))
		Units.to = copy(Units.to, n => new Int32Array(n))
		Units.col = copy(Units.col, n => new Float64Array(n))
		Units.cells = copy(Units.cells, n => new Float64Array(n))
		Units.level = copy(Units.level, n => new Int16Array(n))
		Units.space = copy(Units.space, n => new Uint8Array(n))
	}

	/// Units of a document line's text `from..to` (line-relative), placed
	/// at `lineStart` with columns shifted by `colShift`. A cluster takes
	/// the lowest level of its non-space characters: a shaped word of one
	/// script is drawn whole, so Arabic digits inside it (one level
	/// higher) stay in its run; the browser orders them inside the glyph.
	text(text: string, clusters: Cluster[] | null, levels: Uint8Array, lineStart: number, from: number, to: number, colShift: number) {
		if (!clusters) {
			for (let i = from; i < to; i++) {
				let ch = text.charCodeAt(i)
				this.push(lineStart + i, lineStart + i + 1, i + colShift, 1, levels[i], ch == 9 ? 2 : ch == 32 ? 1 : 0)
			}
			return
		}
		for (let c of clusters) {
			if (c.to <= from) continue
			if (c.from >= to) break
			let level = 255, space = 0
			if (c.kind == ClusterKind.Tab) space = 2
			else if (c.to - c.from == 1 && isBidiSpace(text.charCodeAt(c.from))) space = 1
			else for (let i = c.from; i < c.to; i++) if (levels[i] < level && !isBidiSpace(text.charCodeAt(i))) level = levels[i]
			if (level == 255) level = levels[c.from]
			this.push(lineStart + c.from, lineStart + c.to, c.col + colShift, c.cells, level, space)
		}
	}

	/// Widgets and replaced ranges are neutral: they join the runs
	/// around them when those agree, else take the paragraph level.
	resolveNeutral(base: number) {
		let level = Units.level
		for (let i = 0; i < this.length; i++) {
			if (level[i] >= 0) continue
			let j = i + 1
			while (j < this.length && level[j] < 0) j++
			let before = i ? level[i - 1] : base, after = j < this.length ? level[j] : base
			level[i] = before == after ? before : base
		}
	}

	/// Level runs (logical order) of units `start..end`, a row: rule L1
	/// resets tabs, whitespace before them, and trailing whitespace to
	/// the paragraph level.
	runs(start: number, end: number, base: number): LevelRun[] {
		let runs: LevelRun[] = [], space = Units.space, levels = Units.level, cols = Units.col, cells = Units.cells
		let trail = end
		while (trail > start && space[trail - 1]) trail--
		for (let i = start; i < end; i++) {
			let level = levels[i]
			if (i >= trail || space[i] == 2) level = base
			else if (space[i] == 1) {
				let j = i + 1
				while (j < end && space[j] == 1) j++
				if (j < end && space[j] == 2) level = base
			}
			let last = runs.length ? runs[runs.length - 1] : null, col = cols[i]
			if (last && last.level == level) {
				last.to = Units.to[i]
				last.colTo = col + cells[i]
			} else {
				runs.push({from: Units.from[i], to: Units.to[i], colFrom: col, colTo: col + cells[i], level, x: 0})
			}
		}
		return runs
	}
}

/// The piece after text piece `i` that `pos` (its end) sits after: a
/// widget placed before `pos`, or (unless `side` binds to the text) a
/// replaced range starting there.
function nextAt(ps: Piece[], i: number, pos: number, side: number) {
	let n = ps[i + 1]
	if (!n || n.from != pos) return null
	return n.kind == PieceKind.Widget ? (n.point!.side < 0 ? n : null) : n.kind == PieceKind.Replace && side >= 0 ? n : null
}

/// Continuation indent in columns for `text`: its leading whitespace
/// (plus one or two tab stops), capped at `limit`. Like Acode's
/// `wrappedIndentColumns`, lines with tabs round up to a tab stop.
export function wrapIndentColumns(text: string, tabSize: number, limit: number, mode: WrapIndent) {
	if (mode == "none" || limit <= 0) return 0
	let extra = typeof mode == "number" ? Math.max(0, Math.round(mode)) : mode == "indent" ? tabSize : mode == "deepIndent" ? 2 * tabSize : 0
	let first = text.charCodeAt(0)
	if (first != 32 && first != 9) return Math.min(extra, typeof mode == "number" ? limit : Math.floor(limit / tabSize) * tabSize)
	let step = text.includes("\t") && typeof mode != "number" ? tabSize : 1
	let cap = Math.max(0, Math.floor(limit / step) * step), cols = 0
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i)
		if (c == 32) cols++
		else if (c == 9) cols += tabSize - cols % tabSize
		else break
		if (cols >= cap) return cap
	}
	return Math.min(cap, Math.ceil((cols + extra) / step) * step)
}

// Wrap break classes. A row may end anywhere except inside a word or an
// operator run (`===`, `=>`), before a space (spaces hang), before
// closing punctuation (`)`, `,`, `.`...), so `x =` | `y`, `log(` | `a, `,
// `obj.` | `prop` are all candidates and rows fill up instead of moving
// whole expressions to the next row.
const enum BC { Word = 0, Space = 1, Open = 2, Close = 3, Op = 4, Wide = 5 }
const asciiClass = new Uint8Array(128).fill(BC.Op)
for (let i = 0; i < 128; i++) {
	let ch = String.fromCharCode(i)
	if (/[\w$'"`\\@#]/.test(ch)) asciiClass[i] = BC.Word
}
asciiClass[32] = asciiClass[9] = BC.Space
for (let ch of "([{") asciiClass[ch.charCodeAt(0)] = BC.Open
for (let ch of ")]},;.:") asciiClass[ch.charCodeAt(0)] = BC.Close

function canBreak(a: number, b: number) {
	if (b == BC.Space) return false
	if (a == BC.Space) return true
	if (b == BC.Close) return false
	if (a == BC.Wide || b == BC.Wide) return true
	return !(a == BC.Word && b == BC.Word || a == BC.Op && b == BC.Op)
}

/// Rows of a printable-ASCII line wrapped at `cols`.
export function asciiRows(text: string, cols: number, indent = 0) {
	if (text.length <= cols) return 1
	let rows = 1
	for (let start = 0, len = text.length; len - start > (start ? cols - indent : cols); rows++) {
		let brk = asciiBreak(text, start, start ? cols - indent : cols)
		if (brk < 0) break
		start = brk
	}
	return rows
}

/// Where the row starting at `start` ends (the next row's start), or -1.
function asciiBreak(text: string, start: number, cols: number) {
	let limit = start + cols, len = text.length
	if (text.charCodeAt(limit) == 32) {
		// Spaces at the edge hang past it.
		let brk = limit
		while (brk < len && text.charCodeAt(brk) == 32) brk++
		return brk >= len ? -1 : brk
	}
	// The last break opportunity in the row, unless it's only indentation.
	for (let p = limit; p > start; p--) {
		if (canBreak(asciiClass[text.charCodeAt(p - 1)], asciiClass[text.charCodeAt(p)])) {
			if (hasNonSpace(text, start, p)) return p
			break
		}
	}
	return limit
}

function hasNonSpace(text: string, from: number, to: number) {
	for (let i = from; i < to; i++) if (text.charCodeAt(i) != 32) return true
	return false
}

export function asciiBreaks(text: string, cols: number, out: number[], indent = 0) {
	for (let start = 0, len = text.length; len - start > (start ? cols - indent : cols);) {
		let brk = asciiBreak(text, start, start ? cols - indent : cols)
		if (brk < 0) break
		out.push(brk)
		start = brk
	}
	return out
}

/// Greedy wrapping over layout units (clusters, widgets) with the same
/// break classes as the ASCII path; wide (CJK) characters and widgets
/// break on both sides. Breaks anywhere when a row has no opportunity.
/// Spaces hang past the edge. Tabs on continuation rows stop at that
/// row's tab stops (as the browser lays out CodeMirror's wrapped
/// lines), which moves the rest of the line: the pieces' columns and
/// layouts are updated.
function unitBreaks(vl: VLine, layouts: LineLayouts, wrap: number, indent: number, breaks: number[], breakPos: number[],
	blockRows: (point: PointDeco) => number) {
	let rowStart = 0, rowIndent = 0, opp = -1, oppPos = 0, content = false, prev: number = BC.Space
	// Columns the tabs on continuation rows have moved the units after them by.
	let moved = 0
	let unit = (col: number, cells: number, pos: number, _end: number, kind: number) => {
		// Not after indentation only.
		if (content && col > rowStart && canBreak(prev, kind)) { opp = col; oppPos = pos }
		prev = kind
		if (kind == BC.Space) return
		while (col + cells - rowStart > wrap - rowIndent + 1e-6 && col > rowStart) {
			let useOpp = opp > rowStart && opp <= col
			let bc = useOpp ? opp : col, bp = useOpp ? oppPos : pos
			breaks.push(bc)
			breakPos.push(bp)
			rowStart = bc
			rowIndent = indent
			opp = -1
		}
		content = true
	}
	// A block replace inside the line: the text before ends its row, the
	// widget gets rows of its own, and the text after starts a new one.
	let block = (p: Piece, col: number) => {
		let point = p.point!, rows = point.deco.spec.widget ? blockRows(point) : 0
		let starts: number[] = []
		for (let i = 0; i < rows; i++) starts.push(p.from)
		if (p.to < vl.to - vl.from) starts.push(p.to)
		let first = p.from > 0 ? breaks.length + 1 : 0
		if (p.from == 0) starts.shift()
		for (let pos of starts) {
			breaks.push(col)
			breakPos.push(pos)
		}
		;(vl.inner ??= []).push({point, row: first, rows})
		let flush = vl.flush ??= []
		for (let r = first; r <= first + rows; r++) if (r > 0) flush.push(r)
		rowStart = col
		rowIndent = 0
		opp = -1
		content = false
		prev = BC.Space
	}
	/// Units of a document line's text `from..to`. Returns the line's
	/// clusters with tabs moved, if any were.
	let textUnits = (text: string, layout: Cluster[] | null, lineStart: number, from: number, to: number, colShift: number) => {
		let clusters = layout ?? layouts.get(text)
		if (!clusters) {
			for (let i = from; i < to; i++) unit(i + colShift + moved, 1, lineStart + i, lineStart + i + 1, asciiClass[text.charCodeAt(i)])
			return null
		}
		let out: Cluster[] | null = null, start = moved
		for (let i = 0; i < clusters.length; i++) {
			let c = clusters[i]
			if (c.to <= from) continue
			if (c.from >= to) break
			let col = c.col + colShift + moved, cells = c.cells
			// The row's x of the tab: its stops are the row's.
			if (c.kind == ClusterKind.Tab) cells = tabCells(col - rowStart + rowIndent, layouts.tabSize)
			if (out || cells != c.cells || moved != start) (out ??= clusters.slice())[i] = {...c, col: c.col + moved - start, cells}
			moved += cells - c.cells
			let code = c.text.charCodeAt(0)
			let kind = c.kind == ClusterKind.Tab ? BC.Space
				: c.text.length == 1 && code < 128 ? asciiClass[code]
				: c.kind == ClusterKind.Text && code > 0x2e7f ? BC.Wide : BC.Word
			unit(col, cells, lineStart + c.from, lineStart + c.to, kind)
		}
		return out
	}
	if (!vl.pieces) {
		let layout = textUnits(vl.text, vl.layout, 0, 0, vl.text.length, 0)
		if (layout) vl.layout = layout
		vl.width += moved
		return
	}
	for (let p of vl.pieces) {
		let start = moved
		if (p.kind == PieceKind.Text) {
			let layout = textUnits(p.text, p.layout, p.lineStart, p.from - p.lineStart, p.to - p.lineStart, p.col - p.colBase)
			if (layout) p.layout = layout
			p.cells += moved - start
		} else if (p.point?.blockReplace) {
			block(p, p.col + moved)
		} else if (p.cells > 0) {
			unit(p.col + moved, p.cells, p.from, p.to, BC.Wide)
		}
		p.col += start
	}
	vl.width += moved
}
