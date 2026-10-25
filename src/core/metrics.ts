/// Font configuration for a view. Layout is cell based: every
/// grapheme occupies one or two cells of `cellWidth`, which keeps
/// positions arithmetic (no DOM measurement).
export interface FontSpec {
	family: string
	/// Font size in CSS pixels.
	size: number
	/// Line height as a multiple of the font size.
	lineHeight: number
}

export interface FontMetrics {
	readonly spec: FontSpec
	readonly dpr: number
	/// Cell width in device pixels (an integer, so cells never blur).
	readonly cellWidthDev: number
	/// Line height in device pixels. Fractional, like the DOM's: rows
	/// are snapped to device pixels where they're drawn, so the error
	/// doesn't add up over lines.
	readonly lineHeightDev: number
	/// Baseline offset from the top of a line, in device pixels.
	readonly baselineDev: number
	readonly cellWidth: number
	readonly lineHeight: number
	/// The raw advance of a regular glyph, in device pixels.
	readonly advanceDev: number
}

export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas != "undefined") return new OffscreenCanvas(w, h)
	let c = document.createElement("canvas")
	c.width = w
	c.height = h
	return c
}

export function fontString(spec: FontSpec, dpr: number, bold = false, italic = false) {
	return `${italic ? "italic " : ""}${bold ? "bold " : ""}${spec.size * dpr}px ${spec.family}`
}

/// `lineHeight` is the line height in CSS pixels when it was measured
/// in the DOM (exact); otherwise it's computed from the spec, in
/// Chromium's layout units (1/64 px).
export function measureFont(spec: FontSpec, dpr: number, lineHeight?: number): FontMetrics {
	let cx = makeCanvas(8, 8).getContext("2d") as OffscreenCanvasRenderingContext2D
	cx.font = fontString(spec, dpr)
	let sample = "abcdefghijklmnopqrstuvwxyz0123456789"
	let advanceDev = cx.measureText(sample.repeat(4)).width / (sample.length * 4)
	let m = cx.measureText("Mgjy|")
	let ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent
	let descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent
	let cellWidthDev = Math.max(1, Math.round(advanceDev))
	let lh = Math.max(1 / dpr, lineHeight ?? Math.floor(spec.size * spec.lineHeight * 64) / 64)
	let lineHeightDev = lh * dpr
	let baselineDev = Math.round((lineHeightDev - (ascent + descent)) / 2 + ascent)
	return {
		spec, dpr, cellWidthDev, lineHeightDev, baselineDev, advanceDev,
		cellWidth: cellWidthDev / dpr,
		lineHeight: lh
	}
}
