// Baseline: Ace (as Acode used before CodeMirror) with the same fixture,
// for comparison in the benchmark harness. Syntax highlighting only.
import ace from "ace-builds/src-noconflict/ace"
import "ace-builds/src-noconflict/mode-javascript"
import "ace-builds/src-noconflict/mode-html"
import "ace-builds/src-noconflict/theme-one_dark"
import {type FixtureKind, makeFixture} from "./fixtures"

let params = new URLSearchParams(location.search)
let kind = (params.get("kind") ?? "js") as FixtureKind
let lines = +(params.get("lines") ?? 120000)

let t0 = performance.now()
let doc = makeFixture(kind, lines)
let editor = ace.edit("editor", {
	value: doc,
	mode: kind == "html" ? "ace/mode/html" : "ace/mode/javascript",
	theme: "ace/theme/one_dark",
	useWorker: false,
	fontSize: 14,
	fontFamily: "ui-monospace, 'Roboto Mono', 'Droid Sans Mono', Menlo, Consolas, monospace",
	showPrintMargin: false
})
editor.renderer.setScrollMargin(0, 0, 0, 0)
;(editor.container.style as any).lineHeight = "1.5"
editor.renderer.updateFontSize()
editor.clearSelection()
editor.moveCursorTo(0, 0)

declare global {
	interface Window { aceEditor: any, ready: boolean, createMs: number }
}
window.aceEditor = editor
window.createMs = performance.now() - t0
requestAnimationFrame(() => { window.ready = true })
