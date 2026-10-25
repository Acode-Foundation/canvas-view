// Baseline: stock CodeMirror 6 with the same fixture, for comparison
// in the benchmark harness.
import {html} from "@codemirror/lang-html"
import {javascript} from "@codemirror/lang-javascript"
import {EditorState, StateEffect, StateField} from "@codemirror/state"
import {oneDark} from "@codemirror/theme-one-dark"
import {Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers, WidgetType} from "@codemirror/view"
import {type FixtureKind, makeFixture} from "./fixtures"
import {fontFamily} from "./settings"

let params = new URLSearchParams(location.search)
let kind = (params.get("kind") ?? "js") as FixtureKind
let lines = +(params.get("lines") ?? 120000)
// The same fonts as the canvas demo (`font=fira`).
let font = params.has("font") ? EditorView.theme({".cm-scroller": {fontFamily: fontFamily(params.get("font")!)}}) : []

let t0 = performance.now()
let doc = makeFixture(kind, lines)
let view = new EditorView({
	parent: document.getElementById("editor")!,
	state: EditorState.create({doc, extensions: [
		lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), oneDark, font,
		kind == "html" ? html() : javascript()
	]})
})

declare global {
	interface Window { cm: EditorView, ready: boolean, createMs: number, cmLib: unknown }
}
window.cm = view
// For comparing behavior with canvas-view.
window.cmLib = {Decoration, WidgetType, StateEffect, StateField, EditorView}
window.createMs = performance.now() - t0
requestAnimationFrame(() => { window.ready = true })
