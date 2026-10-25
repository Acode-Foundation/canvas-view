import type {GlyphAtlas} from "../core/atlas"

export const enum ClusterKind { Text = 0, Tab = 1, Control = 2, Shaped = 3 }

/// A unit of layout in a line: a grapheme, a tab, or a run of text
/// that must be shaped together (Arabic, Hebrew...). Columns are
/// counted in cells from the line start and may be fractional: glyphs
/// from fallback fonts (CJK, emoji, other scripts) keep their real
/// advance instead of being rounded to whole cells.
export interface Cluster {
	from: number
	to: number
	col: number
	cells: number
	text: string
	kind: ClusterKind
}

/// Matches printable ASCII lines, which need no cluster layout: one
/// cell per character, column == offset.
export const simpleLine = /^[\x20-\x7e]*$/

const needsSegmenting = /[^\x00-\x7f]/
// Scripts whose letters join, reorder or stack across grapheme
// boundaries (Arabic/Hebrew, Indic, Thai/Lao, Tibetan, Myanmar,
// Khmer). Words of them are drawn as one unit so the browser shapes
// them; cell-by-cell placement breaks joining and the Indic headline.
// Runs stop at spaces and never mix right-to-left and left-to-right
// scripts: word order is the bidi algorithm's job (`bidi.ts`), so each
// run has a single direction.
const rtlScripts = "\\u0590-\\u08ff\\ufb1d-\\ufdff\\ufe70-\\ufefc" // Hebrew, Arabic, Syriac, Thaana, N'Ko
const ltrComplex = "\\u0900-\\u0dff\\u1cd0-\\u1cff\\ua8e0-\\ua8ff" + // Devanagari ... Sinhala, Vedic
	"\\u0e00-\\u0fff\\u1000-\\u109f\\u1780-\\u17ff\\uaa60-\\uaa7f" // Thai, Lao, Tibetan, Myanmar, Khmer
// ZWNJ/ZWJ only continue a run: emoji ZWJ sequences must not start one.
const runOf = (cls: string) => `[${cls}](?:[${cls}\\u200c\\u200d]*[${cls}])?`
const shapedRun = new RegExp(`${runOf(rtlScripts)}|${runOf(ltrComplex)}`, "g")
/// Upper bound for one shaped run, so it fits an atlas row.
const MAX_SHAPED_CELLS = 48

let segmenter: Intl.Segmenter | null = null

/// Width of a tab drawn at x (cells, may be fractional): to the next
/// multiple of `tab`, or the one after when that is less than half a
/// cell away, like Chromium (so CodeMirror) does.
export function tabCells(x: number, tab: number) {
	let cells = tab - (x % tab + tab) % tab
	return cells < 0.5 - 1e-6 ? cells + tab : cells
}

/// `clusters` with the tabs at or after offset `from` stopping where
/// x = col + `shift` is a tab stop, and the clusters after them moved
/// along. The same array when nothing moves. For text drawn at other
/// columns than its document line's (after an inline widget, a fold,
/// on a wrapped row).
export function retab(clusters: Cluster[], from: number, shift: number, tab: number): Cluster[] {
	let out: Cluster[] | null = null, delta = 0
	for (let i = 0; i < clusters.length; i++) {
		let c = clusters[i]
		if (c.from < from) continue
		let cells = c.kind == ClusterKind.Tab ? tabCells(c.col + delta + shift, tab) : c.cells
		if (!out && (delta || cells != c.cells)) out = clusters.slice()
		if (out) out[i] = {...c, col: c.col + delta, cells}
		delta += cells - c.cells
	}
	return out ?? clusters
}

export class LineLayouts {
	private cache = new Map<string, Cluster[]>()

	constructor(private atlas: () => GlyphAtlas, public tabSize: number) {}

	clear() { this.cache.clear() }

	/// Clusters for a line, or null for simple (printable ASCII) lines.
	get(text: string): Cluster[] | null {
		if (simpleLine.test(text)) return null
		let found = this.cache.get(text)
		if (found) return found
		if (this.cache.size > 4000) this.cache.clear()
		found = this.layout(text)
		this.cache.set(text, found)
		return found
	}

	private layout(text: string): Cluster[] {
		let out: Cluster[] = [], col = 0, atlas = this.atlas(), tab = this.tabSize
		let push = (from: number, to: number, seg: string) => {
			let code = seg.charCodeAt(0)
			if (code == 9) {
				let cells = tabCells(col, tab)
				out.push({from, to, col, cells, text: seg, kind: ClusterKind.Tab})
				col += cells
			} else if (code < 32 || code == 127) {
				out.push({from, to, col, cells: 1, text: String.fromCharCode(code == 127 ? 0x2421 : 0x2400 + code), kind: ClusterKind.Control})
				col++
			} else {
				let cells = seg.length == 1 && code < 128 ? 1 : atlas.cellsOf(seg)
				out.push({from, to, col, cells, text: seg, kind: ClusterKind.Text})
				col += cells
			}
		}
		let plain = (from: number, to: number) => {
			if (!needsSegmenting.test(text.slice(from, to))) {
				for (let i = from; i < to; i++) push(i, i + 1, text[i])
				return
			}
			if (!segmenter) segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"})
			for (let {segment, index} of segmenter.segment(text.slice(from, to)))
				push(from + index, from + index + segment.length, segment)
		}
		let pos = 0
		shapedRun.lastIndex = 0
		for (let m; (m = shapedRun.exec(text));) {
			plain(pos, m.index)
			for (let start = m.index, end = m.index + m[0].length; start < end;) {
				// Very long words are split (they rarely exist outside test data).
				let stop = Math.min(end, start + MAX_SHAPED_CELLS)
				let piece = text.slice(start, stop)
				let cells = atlas.shapedCells(piece)
				out.push({from: start, to: start + piece.length, col, cells, text: piece, kind: ClusterKind.Shaped})
				col += cells
				start += piece.length
			}
			pos = m.index + m[0].length
		}
		plain(pos, text.length)
		return out
	}

	/// Column of `offset`, from the line's layout or `clusters` (a
	/// `retab`bed one).
	columnAt(text: string, offset: number, clusters = this.get(text)) {
		if (!clusters) return offset
		for (let c of clusters) {
			if (offset <= c.from) return c.col
			if (offset < c.to) {
				// Inside a shaped run: interpolate.
				return c.col + (offset - c.from) / (c.to - c.from) * c.cells
			}
		}
		let last = clusters[clusters.length - 1]
		return last ? last.col + last.cells : 0
	}

	offsetAtColumn(text: string, column: number, clusters = this.get(text)) {
		if (!clusters) return Math.max(0, Math.min(text.length, Math.round(column)))
		for (let c of clusters) {
			if (column < c.col + c.cells / 2 && c.kind != ClusterKind.Shaped) return c.from
			if (c.kind == ClusterKind.Shaped && column < c.col + c.cells)
				return c.from + Math.max(0, Math.round((column - c.col) / c.cells * (c.to - c.from)))
		}
		return text.length
	}

	/// Width of a line in cells.
	width(text: string) {
		let clusters = this.get(text)
		if (!clusters) return text.length
		let last = clusters[clusters.length - 1]
		return last ? last.col + last.cells : 0
	}
}
