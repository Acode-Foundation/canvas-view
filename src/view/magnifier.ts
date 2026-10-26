/// Options for the touch selection magnifier.
export interface MagnifierConfig {
	/// Magnification. Default 1.25 (Android's and sora-editor's).
	zoom?: number
	/// Size in CSS px. Defaults to sora-editor's actual size: 70 tall,
	/// and 250 device pixels per whole device pixel ratio wide (its
	/// formula truncates the density: ~190 at DPR 2.625, 250 at 2 or
	/// 3), at most 3/5 of the view.
	width?: number
	height?: number
}

/// Text larger than this (CSS px) is readable under the finger: no
/// magnifier, like sora-editor's 28sp limit.
const MAX_FONT_SIZE = 28

/// A loupe over the text a finger is selecting, like Android's text
/// magnifier: the handle (or the long-pressed selection end) hides the
/// text it's on. It's a small 2D canvas over the editor that copies the
/// region around the dragged point out of the GPU canvas, scaled, right
/// after each frame is drawn (a WebGL or WebGPU canvas can be read in
/// the task that drew it). It costs nothing unless a finger drags.
export class Magnifier {
	readonly dom: HTMLCanvasElement
	private cx: CanvasRenderingContext2D | null = null
	private shown = false
	private size = {w: 0, h: 0, dpr: 0}
	private left = NaN
	private top = NaN

	constructor(parent: HTMLElement, private config: MagnifierConfig = {}) {
		let dom = this.dom = document.createElement("canvas")
		dom.className = "cm-canvasMagnifier"
		dom.setAttribute("aria-hidden", "true")
		Object.assign(dom.style, {
			position: "absolute", left: "0", top: "0", display: "none", pointerEvents: "none", zIndex: "5",
			// sora-editor's: 8dp corners, 4dp elevation.
			borderRadius: "8px", boxShadow: "0 2px 6px rgba(0,0,0,0.4)", willChange: "transform"
		} satisfies Partial<CSSStyleDeclaration>)
		parent.appendChild(dom)
	}

	/// Show the magnifier centered on point `x, y` (CSS px in the view),
	/// copying from `source`, the canvas just drawn. `view` is the view's
	/// size and line height.
	show(source: HTMLCanvasElement, x: number, y: number, view: {width: number, height: number, lineHeight: number, fontSize: number}) {
		if (view.fontSize > MAX_FONT_SIZE || !view.width || !source.width) {
			this.hide()
			return
		}
		let zoom = this.config.zoom ?? 1.25, lh = view.lineHeight
		let dpr = window.devicePixelRatio || 1, size = this.size
		let w = Math.round(Math.min(this.config.width ?? Math.min(Math.max(1, Math.floor(dpr)) * 250 / dpr, view.width * 0.6), view.width))
		let h = Math.round(this.config.height ?? 70)
		if (w != size.w || h != size.h || dpr != size.dpr) {
			size.w = w; size.h = h; size.dpr = dpr
			this.dom.width = Math.round(w * dpr)
			this.dom.height = Math.round(h * dpr)
			this.dom.style.width = w + "px"
			this.dom.style.height = h + "px"
			this.cx = null
		}
		let cx = this.cx ??= this.dom.getContext("2d", {alpha: false})
		if (!cx) return
		// The source region, kept inside the canvas (at the view's edges
		// the content stops following the finger, as on Android).
		let scale = source.width / view.width
		let sw = w / zoom, sh = h / zoom
		let sx = Math.max(0, Math.min(view.width - sw, x - sw / 2)), sy = Math.max(0, Math.min(view.height - sh, y - sh / 2))
		cx.imageSmoothingEnabled = true
		cx.drawImage(source, sx * scale, sy * scale, sw * scale, sh * scale, 0, 0, this.dom.width, this.dom.height)
		// A row above the point, clear of the finger (sora-editor's).
		let left = Math.max(0, Math.min(view.width - w, x - w / 2)), top = Math.max(0, y - lh - h)
		if (left != this.left || top != this.top) {
			this.left = left
			this.top = top
			this.dom.style.transform = `translate(${left}px, ${top}px)`
		}
		if (!this.shown) {
			this.shown = true
			this.dom.style.display = "block"
		}
	}

	hide() {
		if (!this.shown) return
		this.shown = false
		this.dom.style.display = "none"
	}

	get visible() { return this.shown }

	destroy() { this.dom.remove() }
}
