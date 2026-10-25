import type {PackedColor} from "./color"

/// Growable typed storage for per-instance GPU data. Each instance is
/// `stride` 32-bit words; the float, uint32 and uint16 views alias the
/// same memory.
///
/// Backends upload only `[dirtyFrom, count)`: appending instances or
/// patching a range marks just that range, so incremental scenes don't
/// re-upload the whole buffer.
export class InstanceBuffer {
	buffer: ArrayBuffer
	f32: Float32Array
	u32: Uint32Array
	u16: Uint16Array
	count = 0
	/// First instance changed since the backend last uploaded.
	dirtyFrom = 0

	constructor(readonly stride: number, capacity = 1024) {
		this.buffer = new ArrayBuffer(capacity * stride * 4)
		this.f32 = new Float32Array(this.buffer)
		this.u32 = new Uint32Array(this.buffer)
		this.u16 = new Uint16Array(this.buffer)
	}

	get capacity() { return this.f32.length / this.stride }

	get byteLength() { return this.count * this.stride * 4 }

	reset() {
		this.count = 0
		this.dirtyFrom = 0
	}

	/// Note that instances from `index` on were modified in place.
	touch(index: number) {
		if (index < this.dirtyFrom) this.dirtyFrom = index
	}

	/// Called by backends after uploading.
	markClean() {
		this.dirtyFrom = this.count
	}

	/// Make room for `n` more instances and return the word offset of
	/// the first one.
	alloc(n: number) {
		let need = this.count + n
		if (need > this.capacity) {
			let cap = this.capacity
			while (cap < need) cap *= 2
			let next = new ArrayBuffer(cap * this.stride * 4)
			new Uint32Array(next).set(this.u32.subarray(0, this.count * this.stride))
			this.buffer = next
			this.f32 = new Float32Array(next)
			this.u32 = new Uint32Array(next)
			this.u16 = new Uint16Array(next)
		}
		let at = this.count * this.stride
		this.touch(this.count)
		this.count = need
		return at
	}
}

/// Glyph instances: x, y (CSS px, top-left of the atlas slot relative
/// to the pass origin), atlas u/v and atlas w/h in texels (uint16
/// pairs), and a packed RGBA tint. A tint of 0 means "color glyph":
/// draw the texture's own colors (emoji).
export const GLYPH_STRIDE = 5

/// Rect instances: x, y, w, h (CSS px) and a packed RGBA color.
export const RECT_STRIDE = 5

export function pushRect(buf: InstanceBuffer, x: number, y: number, w: number, h: number, color: PackedColor) {
	if (w <= 0 || h <= 0 || (color >>> 24) == 0) return
	let at = buf.alloc(1)
	let f = buf.f32
	f[at] = x
	f[at + 1] = y
	f[at + 2] = w
	f[at + 3] = h
	buf.u32[at + 4] = color
}

export function pushGlyph(buf: InstanceBuffer, x: number, y: number,
	g: {u: number, v: number, w: number, h: number, colored: boolean}, color: PackedColor) {
	let at = buf.alloc(1)
	buf.f32[at] = x
	buf.f32[at + 1] = y
	let h = (at + 2) * 2
	buf.u16[h] = g.u
	buf.u16[h + 1] = g.v
	buf.u16[h + 2] = g.w
	buf.u16[h + 3] = g.h
	buf.u32[at + 4] = g.colored ? 0 : color
}

/// Texels `du..du + w` of a glyph's width, drawn at x (where that
/// part starts): a ligature cut where its characters' colors change.
export function pushGlyphPart(buf: InstanceBuffer, x: number, y: number,
	g: {u: number, v: number, w: number, h: number, colored: boolean}, du: number, w: number, color: PackedColor) {
	let at = buf.alloc(1)
	buf.f32[at] = x
	buf.f32[at + 1] = y
	let h = (at + 2) * 2
	buf.u16[h] = g.u + du
	buf.u16[h + 1] = g.v
	buf.u16[h + 2] = w
	buf.u16[h + 3] = g.h
	buf.u32[at + 4] = g.colored ? 0 : color
}
