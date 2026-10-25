import {type FontMetrics, fontString, makeCanvas} from "./metrics"

/// A rasterized glyph in the atlas. Positions and sizes are texels;
/// `ox`/`oy` place the slot relative to the cell's top-left corner in
/// CSS pixels.
export interface GlyphEntry {
	readonly u: number
	readonly v: number
	readonly w: number
	readonly h: number
	readonly ox: number
	readonly oy: number
	readonly cells: number
	/// Color glyphs (emoji) are drawn with their own colors instead of
	/// being tinted.
	readonly colored: boolean
}

/// Entry for glyphs that draw nothing (spaces, unprintable padding).
export const EMPTY_GLYPH: GlyphEntry = {u: 0, v: 0, w: 0, h: 0, ox: 0, oy: 0, cells: 1, colored: false}

/// Font variants: index = (bold ? 1 : 0) | (italic ? 2 : 0).
export type FontVariant = 0 | 1 | 2 | 3

export function fontVariant(bold: boolean, italic: boolean): FontVariant {
	return ((bold ? 1 : 0) | (italic ? 2 : 0)) as FontVariant
}

const colorGlyph = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u

export interface DirtyRect {
	x: number
	y: number
	w: number
	h: number
}

/// Packs glyph coverage masks into a single RGBA texture, one entry
/// per (font variant, grapheme); the shader tints them with the
/// instance color, so syntax colors don't multiply atlas entries.
/// Masks are rasterized in `maskColor` (white for dark themes, black
/// for light ones) so the browser's luminance-dependent contrast
/// tuning roughly matches the final text. Emoji keep their colors.
export class GlyphAtlas {
	size: number
	readonly maxSize: number
	private canvas: OffscreenCanvas | HTMLCanvasElement
	private cx: OffscreenCanvasRenderingContext2D
	private ascii: (GlyphEntry | undefined)[][] = [[], [], [], []]
	private other: Map<string, GlyphEntry>[] = [new Map(), new Map(), new Map(), new Map()]
	private cellCache = new Map<string, number>()
	private padY: number
	private slotH: number
	private penX = 0
	private penY = 0
	private dirty: DirtyRect | null = null
	/// Bumped when the atlas is cleared, invalidating every entry.
	generation = 0
	/// Bumped when the texture must be reallocated (size change).
	sizeVersion = 0
	/// Total texels handed out by `takeDirty`, for diagnostics.
	uploadedTexels = 0

	constructor(readonly metrics: FontMetrics, maxTextureSize = 4096, readonly maskColor = "#fff") {
		this.maxSize = Math.min(4096, maxTextureSize)
		this.size = Math.min(1024, this.maxSize)
		this.padY = Math.ceil(metrics.lineHeightDev * 0.2)
		this.slotH = Math.ceil(metrics.lineHeightDev) + this.padY * 2
		this.canvas = makeCanvas(this.size, this.size)
		this.cx = this.context()
	}

	private context() {
		let cx = this.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D
		cx.textBaseline = "alphabetic"
		return cx
	}

	/// The advance of a grapheme in cells (fractional). Characters the
	/// monospace font covers measure exactly 1 (or 2); fallback glyphs
	/// (CJK, emoji, other scripts) keep their real width, so there are
	/// no gaps after them, as in DOM text.
	cellsOf(g: string): number {
		let code = g.charCodeAt(0)
		if (g.length == 1 && code < 0x300) return 1
		let cached = this.cellCache.get(g)
		if (cached != null) return cached
		let cells = this.measureCells(g)
		this.cellCache.set(g, cells)
		return cells
	}

	private measureCells(text: string) {
		this.cx.font = fontString(this.metrics.spec, this.metrics.dpr)
		let ratio = this.cx.measureText(text).width / this.metrics.advanceDev
		// Snap widths that match the grid (within 2%), so text in the
		// primary font stays column-aligned.
		let whole = Math.round(ratio)
		return whole > 0 && Math.abs(ratio - whole) < 0.02 * whole ? whole : Math.max(0.25, ratio)
	}

	/// Look up (rasterizing on demand) the glyph for an ASCII char code.
	asciiGlyph(variant: FontVariant, code: number): GlyphEntry {
		let table = this.ascii[variant]
		return table[code] ?? (table[code] = this.rasterize(variant, String.fromCharCode(code), 1))
	}

	glyph(variant: FontVariant, g: string): GlyphEntry {
		if (g.length == 1) {
			let code = g.charCodeAt(0)
			if (code < 128) return this.asciiGlyph(variant, code)
		}
		let map = this.other[variant]
		let found = map.get(g)
		if (!found) map.set(g, found = this.rasterize(variant, g, this.cellsOf(g)))
		return found
	}

	/// A custom shape (e.g. a selection handle) drawn with a 2D canvas
	/// path into a `w`×`h` device-pixel slot and cached under `key`. It
	/// is a coverage mask like text, so it's tinted when drawn, unless
	/// `colored` (an image drawn in its own colors, like emoji).
	shape(key: string, w: number, h: number, draw: (cx: OffscreenCanvasRenderingContext2D) => void, colored = false): GlyphEntry {
		let map = this.other[0], fullKey = "\u0002" + key
		let found = map.get(fullKey)
		if (found) return found
		w = Math.min(this.maxSize, Math.ceil(w))
		h = Math.ceil(h)
		while ((w > this.size || h > this.size) && this.size < this.maxSize) this.grow()
		if (this.penX + w > this.size) {
			this.penX = 0
			this.penY += this.slotH
		}
		// Shapes taller than a text slot get their own band.
		let rowH = Math.max(this.slotH, h)
		if (this.penY + rowH > this.size) {
			if (this.size < this.maxSize) this.grow()
			else this.clear()
			return this.shape(key, w, h, draw, colored)
		}
		let x = this.penX, y = this.penY
		this.penX += w
		if (rowH > this.slotH) {
			// Keep the next text slots below the tall shape.
			this.penX = 0
			this.penY += rowH
		}
		let cx = this.cx
		cx.save()
		cx.beginPath()
		cx.rect(x, y, w, h)
		cx.clip()
		cx.translate(x, y)
		cx.fillStyle = cx.strokeStyle = this.maskColor
		draw(cx)
		cx.restore()
		this.markDirty(x, y, x + w, y + h)
		found = {u: x, v: y, w, h, ox: 0, oy: 0, cells: 0, colored}
		map.set(fullKey, found)
		return found
	}

	/// Rasterize printable ASCII for the given variants ahead of use, a
	/// bit at a time (until `deadline`). Returns true when done.
	prewarm(variants: readonly FontVariant[], deadline: number) {
		for (let v of variants) {
			let table = this.ascii[v]
			for (let code = 33; code < 127; code++) {
				if (table[code]) continue
				if (performance.now() > deadline) return false
				table[code] = this.rasterize(v, String.fromCharCode(code), 1)
			}
		}
		return true
	}

	/// The advance, in cells, of a run of text shaped as a whole.
	shapedCells(text: string) {
		return this.measureCells(text)
	}

	/// A run of text rasterized as one unit (so the browser shapes and
	/// orders it), occupying `cells` cells.
	shapedGlyph(variant: FontVariant, text: string, cells: number): GlyphEntry {
		let map = this.other[variant], key = "\u0001" + text
		let found = map.get(key)
		if (!found) {
			// Layout measures the regular font. Where the italic is a
			// narrower fallback (Arabic, Hebrew in most monospace fonts),
			// drawing it would leave gaps between words: draw it upright.
			if (variant & 2) {
				this.cx.font = fontString(this.metrics.spec, this.metrics.dpr, (variant & 1) > 0, true)
				let ratio = this.cx.measureText(text).width / (cells * this.metrics.advanceDev)
				if (Math.abs(ratio - 1) > 0.05) variant = (variant & ~2) as FontVariant
			}
			map.set(key, found = this.rasterize(variant, text, cells))
		}
		return found
	}

	private rasterize(variant: FontVariant, g: string, cells: number): GlyphEntry {
		if (g == " " || g == "\u00a0") return EMPTY_GLYPH
		let m = this.metrics
		let cx = this.cx
		cx.font = fontString(m.spec, m.dpr, (variant & 1) > 0, (variant & 2) > 0)
		// Size the slot to the glyph's ink (plus a texel of antialiasing
		// margin) rather than a fixed padding, so far more glyphs fit
		// before the atlas has to grow.
		let ink = cx.measureText(g)
		let left = Math.floor(-ink.actualBoundingBoxLeft) - 1
		let right = Math.ceil(ink.actualBoundingBoxRight) + 1
		if (!(right > left + 2)) return {...EMPTY_GLYPH, cells}
		let w = Math.min(this.maxSize, right - left), h = this.slotH
		while (w > this.size && this.size < this.maxSize) this.grow()
		if (this.penX + w > this.size) {
			this.penX = 0
			this.penY += h
		}
		if (this.penY + h > this.size) {
			if (this.size < this.maxSize) this.grow()
			else this.clear()
			// Retry after making room. A cleared atlas always has space.
			return this.rasterize(variant, g, cells)
		}
		let x = this.penX, y = this.penY
		this.penX += w
		cx.fillStyle = this.maskColor
		cx.save()
		cx.beginPath()
		cx.rect(x, y, w, h)
		cx.clip()
		cx.fillText(g, x - left, y + this.padY + m.baselineDev)
		cx.restore()
		this.markDirty(x, y, x + w, y + h)
		return {u: x, v: y, w, h, ox: left / m.dpr, oy: -this.padY / m.dpr, cells, colored: colorGlyph.test(g)}
	}

	private markDirty(x0: number, y0: number, x1: number, y1: number) {
		let d = this.dirty
		if (!d) {
			this.dirty = {x: x0, y: y0, w: x1 - x0, h: y1 - y0}
		} else {
			let nx = Math.min(d.x, x0), ny = Math.min(d.y, y0)
			d.w = Math.max(d.x + d.w, x1) - nx
			d.h = Math.max(d.y + d.h, y1) - ny
			d.x = nx
			d.y = ny
		}
	}

	private grow() {
		let old = this.canvas
		this.size *= 2
		this.canvas = makeCanvas(this.size, this.size)
		this.cx = this.context()
		this.cx.drawImage(old as any, 0, 0)
		// Backends copy the old texture into the new one on the GPU, so
		// only pending changes need uploading.
		this.sizeVersion++
	}

	/// Drop every glyph. Callers must rebuild anything holding entries
	/// (detectable through `generation`).
	clear() {
		this.cx.clearRect(0, 0, this.size, this.size)
		this.penX = this.penY = 0
		for (let i = 0; i < this.ascii.length; i++) {
			this.ascii[i] = []
			this.other[i] = new Map()
		}
		this.generation++
		this.dirty = null
	}

	/// The canvas glyphs are rasterized into (the upload source).
	get source() { return this.canvas }

	/// Height of the used part of the atlas, in texels.
	get usedHeight() { return Math.min(this.size, this.penY + this.slotH) }

	/// Mark everything used dirty, for backends that (re)created their
	/// texture without a copy of the old one.
	markAllDirty() {
		if (this.penY || this.penX) this.markDirty(0, 0, this.size, this.usedHeight)
	}

	/// Take the rectangle changed since the last call.
	takeDirty(): DirtyRect | null {
		let d = this.dirty
		if (!d) return null
		this.dirty = null
		d.w = Math.min(d.w, this.size - d.x)
		d.h = Math.min(d.h, this.size - d.y)
		this.uploadedTexels += d.w * d.h
		return d
	}

	/// Read a rectangle back as premultiplied RGBA (fallback upload path).
	readPremultiplied(r: DirtyRect): Uint8Array {
		let img = this.cx.getImageData(r.x, r.y, r.w, r.h)
		let data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
		for (let i = 0; i < data.length; i += 4) {
			let a = data[i + 3]
			if (a == 0) {
				data[i] = data[i + 1] = data[i + 2] = 0
			} else if (a < 255) {
				data[i] = (data[i] * a + 127) / 255
				data[i + 1] = (data[i + 1] * a + 127) / 255
				data[i + 2] = (data[i + 2] * a + 127) / 255
			}
		}
		return data
	}
}
