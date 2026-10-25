// Colors are packed as 0xAABBGGRR so that a Uint32 written on a
// little-endian machine lands in memory as R, G, B, A bytes, which is
// what both GPU backends read as a normalized unorm8x4 attribute.

export type PackedColor = number

export function packRGBA(r: number, g: number, b: number, a = 255): PackedColor {
	return ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0
}

export function unpackRGBA(c: PackedColor): [number, number, number, number] {
	return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24]
}

const cache = new Map<string, PackedColor>()
let probe: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null

function probeContext() {
	if (probe) return probe
	let canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas != "undefined"
		? new OffscreenCanvas(1, 1) : document.createElement("canvas")
	probe = canvas.getContext("2d", {willReadFrequently: true}) as any
	if (!probe) throw new Error("canvas-view: no 2D context available for color parsing")
	return probe
}

const hexRe = /^#([0-9a-f]{3,8})$/i
const rgbRe = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i

function parseFast(css: string): PackedColor | null {
	let m = hexRe.exec(css)
	if (m) {
		let h = m[1]
		if (h.length == 3 || h.length == 4) {
			let v = [...h].map(c => parseInt(c + c, 16))
			return packRGBA(v[0], v[1], v[2], h.length == 4 ? v[3] : 255)
		}
		if (h.length == 6 || h.length == 8) {
			let n = (i: number) => parseInt(h.slice(i, i + 2), 16)
			return packRGBA(n(0), n(2), n(4), h.length == 8 ? n(6) : 255)
		}
		return null
	}
	m = rgbRe.exec(css)
	if (m) {
		let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])
		return packRGBA(Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), Math.round(a * 255))
	}
	return null
}

/// Parse any CSS color string into a packed RGBA value. Named colors
/// and other syntaxes are resolved through a 2D canvas, which works in
/// workers as well.
export function parseColor(css: string): PackedColor {
	let cached = cache.get(css)
	if (cached != null) return cached
	let result = parseFast(css.trim())
	if (result == null) {
		let cx = probeContext()
		cx.clearRect(0, 0, 1, 1)
		cx.fillStyle = "#000"
		cx.fillStyle = css
		cx.fillRect(0, 0, 1, 1)
		let d = cx.getImageData(0, 0, 1, 1).data
		result = packRGBA(d[0], d[1], d[2], d[3])
	}
	cache.set(css, result)
	return result
}

export function colorToCSS(c: PackedColor) {
	let [r, g, b, a] = unpackRGBA(c)
	return a == 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}
