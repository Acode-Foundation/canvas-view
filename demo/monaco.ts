// Baseline: Monaco (VS Code's editor) with the same fixture, for
// comparison in the benchmark harness. Monarch syntax highlighting only
// (no TypeScript language service), like the other editors here.
import * as monaco from "monaco-editor/editor/editor.api.js"
import "monaco-editor/basic-languages/monaco.contribution.js"
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker"
import {type FixtureKind, makeFixture} from "./fixtures"

;(self as any).MonacoEnvironment = {getWorker: () => new EditorWorker()}

let params = new URLSearchParams(location.search)
let kind = (params.get("kind") ?? "js") as FixtureKind
let lines = +(params.get("lines") ?? 120000)

let t0 = performance.now()
let doc = makeFixture(kind, lines)
let editor = monaco.editor.create(document.getElementById("editor")!, {
	value: doc,
	language: kind == "html" ? "html" : "javascript",
	theme: "vs-dark",
	fontSize: 14,
	lineHeight: 21,
	fontFamily: "ui-monospace, 'Roboto Mono', 'Droid Sans Mono', Menlo, Consolas, monospace",
	minimap: {enabled: false},
	automaticLayout: true,
	scrollBeyondLastLine: true
})

declare global {
	interface Window { monacoEditor: monaco.editor.IStandaloneCodeEditor, ready: boolean, createMs: number }
}
window.monacoEditor = editor
window.createMs = performance.now() - t0
requestAnimationFrame(() => { window.ready = true })
