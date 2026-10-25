// Extra gutter columns from CodeMirror's `gutter()` API (lint markers,
// breakpoints, git changes...). Line numbers and fold markers are drawn
// by the view itself; every other `gutter()` config becomes a narrow
// column left of the line numbers, its markers drawn from the atlas.

import type {RangeSet} from "@codemirror/state"
import {gutter, type GutterMarker} from "@codemirror/view"
import {type PackedColor, parseColor} from "../core/color"
import {type MarkStyle, parseInlineStyle} from "./decorations"

/// CodeMirror's internal `activeGutters` facet, recovered from a probe.
const probe: any = gutter({class: "cv-probe"})
const activeGutters: any = (() => {
	let walk = (e: any): any => {
		if (!e || typeof e != "object") return null
		if (Array.isArray(e)) { for (let x of e) { let r = walk(x); if (r) return r } return null }
		if (e.facet && e.value?.class == "cv-probe") return e
		return e.inner ? walk(e.inner) : null
	}
	return walk(probe)?.facet ?? null
})()
const defaultLineMarker = (() => {
	let walk = (e: any): any => Array.isArray(e) ? e.map(walk).find(Boolean) : e?.value?.class == "cv-probe" ? e.value.lineMarker : null
	return walk(probe)
})()

/// Gutters the view draws itself.
const nativeGutterClasses = /(^|\s)(cm-lineNumbers|cm-foldGutter)(\s|$)/

export interface GutterConfig {
	class: string
	markers: (view: any) => RangeSet<GutterMarker> | readonly RangeSet<GutterMarker>[]
	lineMarker: (view: any, line: any, others: readonly GutterMarker[]) => GutterMarker | null
	domEventHandlers: {[event: string]: (view: any, line: any, event: Event) => boolean}
	side?: "before" | "after"
}

/// What a gutter marker draws: a built-in shape, or a text label.
export interface MarkerLook {
	shape: "dot" | "triangle" | "square" | "bar" | null
	color: PackedColor | null
	text: string
	textColor: PackedColor | null
	dom: HTMLElement | null
}

const lintShapes: Record<string, {shape: MarkerLook["shape"], color: string}> = {
	error: {shape: "dot", color: "#e5484d"},
	warning: {shape: "triangle", color: "#f5a623"},
	info: {shape: "dot", color: "#4c9aff"},
	hint: {shape: "dot", color: "#8f8f9d"}
}

export class Gutters {
	private looks = new WeakMap<GutterMarker, MarkerLook>()

	/// Extra gutter configs in the state (not line numbers or folding).
	columns(state: any): readonly GutterConfig[] {
		if (!activeGutters) return []
		let all = state.facet(activeGutters) as readonly GutterConfig[]
		return all.filter(g => !nativeGutterClasses.test(g.class))
	}

	/// Whether a config adds line markers through `lineMarker`.
	hasLineMarker(g: GutterConfig) { return g.lineMarker !== defaultLineMarker }

	/// Marker sets of a gutter, as an array.
	markerSets(g: GutterConfig, view: any): readonly RangeSet<GutterMarker>[] {
		let m = g.markers(view)
		return Array.isArray(m) ? m : [m as RangeSet<GutterMarker>]
	}

	/// How a marker draws: lint markers get built-in shapes; others are
	/// read from `toCanvas()` or their DOM (text, colors), once per marker.
	look(marker: GutterMarker, view: any): MarkerLook {
		let found = this.looks.get(marker)
		if (found) return found
		let m = marker as GutterMarker & {toCanvas?: (view: any) => Partial<MarkerLook> & {style?: MarkStyle}}
		let look: MarkerLook = {shape: null, color: null, text: "", textColor: null, dom: null}
		if (typeof m.toCanvas == "function") {
			let spec = m.toCanvas(view)
			look.shape = spec.shape ?? null
			look.text = spec.text ?? ""
			look.color = spec.style?.background ? parseColor(spec.style.background) : null
			look.textColor = spec.style?.color ? parseColor(spec.style.color) : null
		} else {
			let dom: HTMLElement | null = null
			try { dom = (marker.toDOM?.(view) as HTMLElement | undefined) ?? null } catch {}
			let cls = ((dom?.className ?? "") + " " + (marker.elementClass ?? "")).trim()
			let lint = /cm-lint-marker-(error|warning|info|hint)/.exec(cls)
			look.dom = dom
			if (lint) {
				look.shape = lintShapes[lint[1]].shape
				look.color = parseColor(lintShapes[lint[1]].color)
			} else {
				look.text = (dom?.textContent ?? "").trim()
				let style = dom?.style?.cssText ? parseInlineStyle(dom.style.cssText) : null
				if (style?.color) look.textColor = parseColor(style.color)
				if (style?.background) look.color = parseColor(style.background)
				// An empty element with a background: a dot (breakpoints...).
				if (!look.text && look.color != null) look.shape = /radius/.test(dom?.style?.cssText ?? "") ? "dot" : "bar"
			}
		}
		this.looks.set(marker, look)
		return look
	}
}
