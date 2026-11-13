import type {GlyphAtlas} from "./atlas"
import type {PackedColor} from "./color"
import type {InstanceBuffer} from "./instances"

export interface ClipRect {
	x: number
	y: number
	w: number
	h: number
}

/// One draw call: a range of rect or glyph instances, translated by
/// an offset (CSS px) and optionally clipped. Scrolling only changes
/// pass offsets, so a pure scroll frame uploads nothing.
export interface DrawPass {
	kind: "rect" | "glyph"
	buffer: InstanceBuffer
	first: number
	count: number
	offsetX: number
	offsetY: number
	clip?: ClipRect | null
}

export type BackendKind = "webgl2" | "webgpu"

/// A canvas dimension in device pixels for a size in CSS pixels.
export function deviceSize(px: number, dpr: number) {
	return Math.max(1, Math.round(px * dpr))
}

export interface RenderBackend {
	readonly kind: BackendKind
	readonly maxTextureSize: number
	/// True when the GPU context was lost and the backend can't draw.
	readonly lost: boolean
	/// Whether the canvas is see-through where nothing opaque is drawn
	/// (a background with alpha below 1), so the page behind it shows.
	/// Opaque canvases are cheaper to composite, so it's only on when
	/// the theme asks for it.
	readonly transparent: boolean
	/// Switch transparency without a new context. Returns false when the
	/// backend can't (a WebGL2 context's `alpha` is fixed at creation):
	/// the caller then creates a new backend on a new canvas.
	setTransparent(on: boolean): boolean
	/// Called when the GPU context is lost. `permanent` means it can't
	/// come back by itself (a WebGPU device loss): the backend must be
	/// replaced. Otherwise (WebGL2) a restore may follow.
	onLost: ((permanent: boolean) => void) | null
	/// Called when a lost context was restored and the backend rebuilt
	/// its GPU objects. Nothing is drawn until the next `render`, which
	/// re-uploads the atlas and every buffer.
	onRestored: (() => void) | null
	/// Set the drawing surface size in CSS pixels. Returns true when
	/// the canvas was reallocated, which clears it: the caller must draw
	/// again before the browser paints, or a blank frame shows.
	resize(width: number, height: number, dpr: number): boolean
	/// Upload pending atlas changes (and reallocate on size changes).
	syncAtlas(atlas: GlyphAtlas): void
	/// Clear to `background` (not premultiplied; its alpha is used only
	/// on a transparent canvas) and draw the passes.
	render(background: PackedColor, passes: readonly DrawPass[]): void
	destroy(): void
}

export type Canvas = HTMLCanvasElement | OffscreenCanvas
