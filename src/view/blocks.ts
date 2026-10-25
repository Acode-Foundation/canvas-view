// Block widgets (`Decoration.widget({block: true})`): real DOM, shown in
// rows reserved for them between lines, positioned over the canvas.
// Only widgets that get on screen have DOM; the rows of the others come
// from heights measured before (the widget's, or the last one of its
// class) or `estimatedHeight`, so a document with thousands of block
// widgets doesn't create thousands of elements. Only the visible ones
// are positioned each frame (a transform each).

import type {WidgetType} from "@codemirror/view"
import {domViews} from "./compat"
import type {PointDeco} from "./decorations"

interface Entry {
	widget: WidgetType
	dom: HTMLElement
	height: number
	shown: boolean
	/// Frames since it was last on screen.
	hidden: number
}

export interface BlockHost {
	readonly lineHeight: number
	/// The block widget rows changed height (re-measure layout there).
	blockResized(point: PointDeco): void
	/// Whether a widget is in the current decorations.
	isLive(widget: WidgetType): boolean
}

/// Widgets with DOM that weren't on screen for this many frames give it up.
const MAX_HIDDEN = 64

export class BlockLayer {
	readonly dom: HTMLElement
	/// Widgets that have DOM (on screen now or recently).
	private entries = new Map<WidgetType, Entry>()
	private points = new Map<WidgetType, PointDeco>()
	private byDom = new WeakMap<Element, Entry>()
	/// Measured heights of widgets without DOM now, and the last measured
	/// height per widget class (a good guess for new ones of that class).
	private heights = new WeakMap<WidgetType, number>()
	private typical = new Map<Function, number>()
	/// DOM of widgets that just left the decorations, offered to their
	/// replacements (equal, or `updateDOM`-able) during this frame's
	/// placement, then dropped.
	private spare: Entry[] = []
	private observer: ResizeObserver

	constructor(private host: BlockHost, private view: unknown, parent: HTMLElement) {
		this.dom = document.createElement("div")
		this.dom.className = "cv-blocks"
		Object.assign(this.dom.style, {position: "absolute", left: "0", top: "0", right: "0", bottom: "0",
			overflow: "hidden", pointerEvents: "none", zIndex: "1"} satisfies Partial<CSSStyleDeclaration>)
		parent.appendChild(this.dom)
		this.observer = new ResizeObserver(records => {
			for (let r of records) {
				let entry = this.byDom.get(r.target)
				if (!entry || !entry.shown) continue
				let h = (r.target as HTMLElement).offsetHeight
				if (Math.abs(h - entry.height) < 0.5) continue
				let before = this.rowsOf(entry.height)
				this.setHeight(entry, h)
				let point = this.points.get(entry.widget)
				if (point && this.rowsOf(h) != before) this.host.blockResized(point)
			}
		})
	}

	private rowsOf(height: number) { return Math.max(1, Math.ceil(height / this.host.lineHeight - 0.01)) }

	private setHeight(entry: Entry, h: number) {
		entry.height = h
		this.heights.set(entry.widget, h)
		this.typical.set(entry.widget.constructor, h)
	}

	/// Rows a block widget takes, without creating its DOM: its measured
	/// height, its `estimatedHeight`, or the last height of its class.
	rows(point: PointDeco) {
		let widget = point.deco.spec.widget as WidgetType
		let h = this.entries.get(widget)?.height ?? this.heights.get(widget)
		if (h == null) h = widget.estimatedHeight >= 0 ? widget.estimatedHeight : this.typical.get(widget.constructor) ?? this.host.lineHeight
		return this.rowsOf(h)
	}

	private entry(point: PointDeco) {
		let widget = point.deco.spec.widget as WidgetType
		this.points.set(widget, point)
		let entry = this.entries.get(widget)
		if (entry) return entry
		// Like CodeMirror, reuse the DOM of a replaced widget: an equal
		// one as it is, then one whose DOM `updateDOM` updates in place.
		for (let pass = 0; pass < 2; pass++) for (let i = 0; i < this.spare.length; i++) {
			let e = this.spare[i], old = e.widget
			if (old.constructor != widget.constructor) continue
			if (pass == 0 ? !widget.eq(old) : !widget.updateDOM(e.dom, this.view as any, old)) continue
			this.spare.splice(i, 1)
			e.widget = widget
			this.entries.set(widget, e)
			this.heights.set(widget, e.height)
			return e
		}
		let guess = this.rows(point)
		let dom = widget.toDOM(this.view as any)
		domViews.set(dom, this.view)
		Object.assign(dom.style, {position: "absolute", left: "0", top: "0", pointerEvents: "auto", boxSizing: "border-box",
			visibility: "hidden"} satisfies Partial<CSSStyleDeclaration>)
		dom.classList.add("cm-widgetBuffer")
		this.dom.appendChild(dom)
		entry = {widget, dom, height: 0, shown: false, hidden: 0}
		this.byDom.set(dom, entry)
		this.setHeight(entry, dom.offsetHeight || this.host.lineHeight)
		this.entries.set(widget, entry)
		this.observer.observe(dom)
		// Its rows were a guess: correct them now that it's measured.
		if (this.rowsOf(entry.height) != guess) this.host.blockResized(point)
		return entry
	}

	private placed = new Set<Entry>()
	private left = 0

	/// Where the layer starts (CSS px from the view's left edge: the
	/// gutter's edge, so widgets scroll under the gutter). Widgets are
	/// positioned relative to it.
	setLeft(px: number) {
		if (px != this.left) {
			this.left = px
			this.dom.style.left = px + "px"
		}
	}

	/// Start a frame's placement: widgets no longer decorated become
	/// spares their replacements can take over.
	begin() {
		this.placed.clear()
		for (let [widget, entry] of this.entries) {
			if (this.host.isLive(widget)) continue
			this.entries.delete(widget)
			this.points.delete(widget)
			this.spare.push(entry)
		}
	}

	/// Show a widget at (x, y) with a width (CSS px).
	place(point: PointDeco, x: number, y: number, width: number) {
		let entry = this.entry(point)
		this.placed.add(entry)
		let style = entry.dom.style
		let transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
		if (style.transform != transform) style.transform = transform
		let w = Math.round(width) + "px"
		if (style.width != w) style.width = w
		if (!entry.shown) {
			entry.shown = true
			style.visibility = ""
		}
	}

	/// Hide what wasn't placed, drop unused spares, and take the DOM of
	/// widgets that were off screen for a while.
	end() {
		for (let e of this.spare) this.drop(e)
		this.spare = []
		for (let [widget, entry] of this.entries) {
			if (this.placed.has(entry)) { entry.hidden = 0; continue }
			if (entry.shown) {
				entry.shown = false
				entry.dom.style.visibility = "hidden"
			}
			if (++entry.hidden > MAX_HIDDEN) {
				this.entries.delete(widget)
				this.points.delete(widget)
				this.drop(entry)
			}
		}
	}

	private drop(entry: Entry) {
		this.observer.unobserve(entry.dom)
		entry.dom.remove()
		try { entry.widget.destroy(entry.dom) } catch {}
	}

	/// Whether an event target is inside a block widget.
	contains(target: EventTarget | null) {
		return target instanceof Node && target != this.dom && this.dom.contains(target)
	}

	get size() { return this.entries.size + this.spare.length }

	destroy() {
		this.observer.disconnect()
		for (let [widget, entry] of this.entries) try { widget.destroy(entry.dom) } catch {}
		for (let e of this.spare) try { e.widget.destroy(e.dom) } catch {}
		this.dom.remove()
	}
}
