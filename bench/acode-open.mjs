// Sets Acode's renderer and opens a local file as an Acode file, for
// measuring Acode from outside (SurfaceFlinger, screenshots) on a device.
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//   node bench/acode-open.mjs --config=webgl2|webgpu|dom --file=path [--name=bench.js] [--restore]
import {readFile} from "node:fs/promises"
import {basename} from "node:path"
import puppeteer from "puppeteer-core"
import {parseArgs, sleep} from "./harness.mjs"

const args = parseArgs()
const browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
const page = (await browser.pages()).find(p => p.url().endsWith("/index.html"))

if (args.config) {
	let want = args.config == "dom" ? {editorRenderer: "dom"} : {editorRenderer: "canvas", canvasBackend: args.config}
	let current = await page.evaluate(() => {
		let v = acode.require("settings").value
		return {editorRenderer: v.editorRenderer, canvasBackend: v.canvasBackend}
	})
	if (current.editorRenderer != want.editorRenderer || (want.canvasBackend && current.canvasBackend != want.canvasBackend)) {
		await page.evaluate(w => acode.require("settings").update(w, false), want)
		await page.reload({waitUntil: "domcontentloaded"}).catch(() => {})
		await page.waitForFunction(() => window.editorManager?.editor && editorManager.activeFile?.loaded, {timeout: 60000, polling: 200})
		await sleep(3000)
	}
	console.log("was", JSON.stringify(current))
}
if (args.file) {
	let text = await readFile(args.file, "utf8")
	let name = args.name ?? basename(args.file)
	let r = await page.evaluate(async (text, name) => {
		let EditorFile = acode.require("EditorFile"), t0 = performance.now()
		let file = new EditorFile(name, {text})
		while (!(editorManager.activeFile == file && editorManager.editor.state.doc.length == text.length)) {
			if (performance.now() - t0 > 60000) break
			await new Promise(r => requestAnimationFrame(r))
		}
		return {textMs: Math.round(performance.now() - t0), backend: editorManager.editor.debug?.backend ?? "dom"}
	}, text, name)
	console.log(JSON.stringify(r))
}
await browser.disconnect()
