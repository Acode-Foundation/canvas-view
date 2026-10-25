// canvas-view inside Acode on a USB-connected Android device (debug
// build, WebView devtools forwarded to localhost:9333), per renderer
// config and CPU level, on the demo's JS fixture opened as an Acode file:
//  - open: when the file's text is shown, and when most visible lines
//    have colors (from opening the file)
//  - colors after jumping to the end of the file
//  - JS heap: the app's after opening, and the file's share
//  - touch flings (frame intervals while moving, main-thread time per
//    frame, long tasks, blank frames for the DOM editor)
//  - typing: key event → end of the frame that shows it, main-thread
//    time per key (same method as bench/compare.mjs)
//
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//   node bench/acode.mjs [--configs=dom,webgl2,webgpu] [--cpu=1,2,4,6] [--lines=120000]
// Acode's renderer settings are switched (with a reload) and restored.

import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"
import puppeteer from "puppeteer-core"
import {makeFixture} from "../demo/fixtures.ts"
import {parseArgs, sleep} from "./harness.mjs"

const args = parseArgs()
const configs = (args.configs ?? "dom,webgl2,webgpu").split(",")
const cpus = (args.cpu ?? "1,2,4,6").split(",").map(Number)
const lines = +(args.lines ?? 120000)
const text = makeFixture("js", lines)
const browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
const page = (await browser.pages()).find(p => p.url().endsWith("/index.html"))
const cdp = await page.createCDPSession()
await cdp.send("Performance.enable")

const pct = (arr, p) => {
	if (!arr.length) return 0
	let s = [...arr].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const metrics = async () => {
	let m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(x => [x.name, x.value]))
	return {task: m.TaskDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration}
}
const diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, (b[k] - a[k]) * 1000]))
const heapNow = async () => {
	await cdp.send("HeapProfiler.collectGarbage")
	return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576
}

// In the page: [visible non-blank lines, colored ones] for the active
// editor, and a poll for when 60% are colored.
const probe = () => {
	window.__benchColored = () => {
		let ed = editorManager.editor, doc = ed.state.doc, n = 0, c = 0
		if (ed.syntax) {
			let a = ed.lineAtHeight(ed.scrollTop), b = ed.lineAtHeight(ed.scrollTop + ed.height)
			for (let i = a; i <= b; i++) {
				if (!doc.line(i).text.trim()) continue
				n++
				let seg = ed.scene.segments.get(i)
				if (seg && seg.runs && seg.runs.length) c++
			}
		} else {
			let r = ed.scrollDOM.getBoundingClientRect()
			for (let el of ed.contentDOM.querySelectorAll(".cm-line")) {
				let e = el.getBoundingClientRect()
				if (e.bottom <= r.top || e.top >= r.bottom || !el.textContent.trim()) continue
				n++
				if (el.querySelector("span")) c++
			}
		}
		return [n, c]
	}
	window.__benchWaitColored = (t0, extra = () => true) => new Promise(done => {
		let poll = () => {
			let r = extra() ? window.__benchColored() : [0, 0]
			if (r[0] > 0 && r[1] >= r[0] * 0.6) done(performance.now() - t0)
			else if (performance.now() - t0 > 60000) done(-1)
			else setTimeout(poll, 16)
		}
		poll()
	})
}

async function configure(config) {
	let want = config == "dom" ? {editorRenderer: "dom"} : {editorRenderer: "canvas", canvasBackend: config}
	let current = await page.evaluate(() => {
		let v = acode.require("settings").value
		return {editorRenderer: v.editorRenderer, canvasBackend: v.canvasBackend}
	})
	await page.evaluate(w => acode.require("settings").update(w, false), want)
	await page.reload({waitUntil: "domcontentloaded"}).catch(() => {})
	await page.waitForFunction(() => window.editorManager?.editor && editorManager.activeFile?.loaded, {timeout: 60000, polling: 200})
	await sleep(4000)
	let backend = await page.evaluate(() => editorManager.editor.debug?.backend ?? "dom")
	return {current, backend}
}

async function run(config, cpu) {
	await page.evaluate(probe)
	let heapBefore = await heapNow()
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
	// Open the file: text, then colors.
	let open = await page.evaluate(async text => {
		let EditorFile = acode.require("EditorFile"), t0 = performance.now(), textAt = -1
		let file = new EditorFile("bench.js", {text})
		window.__benchFile = file
		let shown = () => editorManager.activeFile == file && editorManager.editor.state.doc.length == text.length
		await new Promise(done => {
			let poll = () => {
				if (shown()) { textAt = performance.now() - t0; done() }
				else if (performance.now() - t0 > 60000) done()
				else requestAnimationFrame(poll)
			}
			poll()
		})
		let colorsAt = await window.__benchWaitColored(t0, shown)
		return {textAt, colorsAt}
	}, text)
	await sleep(1500)
	let colorsAtEnd = await page.evaluate(() => {
		let ed = editorManager.editor, t0 = performance.now()
		ed.scrollDOM.scrollTop = 1e9
		return window.__benchWaitColored(t0)
	})
	await page.evaluate(() => { editorManager.editor.scrollDOM.scrollTop = 0 })
	await sleep(1500)
	let heap = await heapNow()

	// Flings, in the editor's area.
	let box = await page.evaluate(() => {
		let r = editorManager.editor.scrollDOM.getBoundingClientRect()
		return {x: r.left + r.width / 2, top: r.top, bottom: r.bottom, h: r.height}
	})
	let swipe = Math.min(500 * (await page.evaluate(() => innerHeight)) / 860, box.h * 0.75)
	let low = box.bottom - box.h * 0.12, high = low - swipe
	let flingStart = await metrics()
	await page.evaluate(() => {
		window.__samples = []
		window.__longtasks = []
		window.__stop = false
		new PerformanceObserver(list => { for (let e of list.getEntries()) window.__longtasks.push(e.duration) })
			.observe({type: "longtask"})
		let ed = editorManager.editor, s = ed.scrollDOM
		let loop = t => {
			let top = s.scrollTop, miss = false
			if (!ed.syntax) {
				let base = ed.documentTop - s.getBoundingClientRect().top + top
				miss = top < ed.lineBlockAt(ed.viewport.from).top + base - 1 || top + s.clientHeight > ed.lineBlockAt(ed.viewport.to).bottom + base + 1
			}
			window.__samples.push({t, top, miss})
			if (!window.__stop) requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	})
	let readTop = () => page.evaluate(() => editorManager.editor.scrollDOM.scrollTop)
	let touch = (type, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x: box.x, y, id: 1}]})
	let distances = []
	for (let i = 0; i < 8; i++) {
		let up = i >= 6, from = up ? high : low, to = up ? low : high
		let before = await readTop()
		await touch("touchStart", from)
		for (let k = 1; k <= 12; k++) {
			await sleep(8)
			await touch("touchMove", from + (to - from) * k / 12)
		}
		await touch("touchEnd")
		let last = await readTop(), still = 0
		for (let w = 0; w < 80 && still < 4; w++) {
			await sleep(60)
			let now = await readTop()
			still = Math.abs(now - last) < 0.5 ? still + 1 : 0
			last = now
		}
		distances.push(Math.round(last - before))
	}
	let fling = await page.evaluate(() => {
		window.__stop = true
		return {samples: window.__samples, longtasks: window.__longtasks.splice(0)}
	})
	let flingCost = diff(flingStart, await metrics())
	let moving = []
	for (let i = 1; i < fling.samples.length; i++) {
		let a = fling.samples[i - 1], b = fling.samples[i]
		if (Math.abs(b.top - a.top) > 0.5) moving.push(b.t - a.t)
	}

	// Typing at the end of line 12.
	await page.evaluate(() => {
		let ed = editorManager.editor, l = ed.state.doc.line(12)
		ed.dispatch({selection: {anchor: l.to}, scrollIntoView: true})
		ed.focus()
	})
	await sleep(1500)
	let typeStart = await metrics()
	await page.evaluate(() => {
		window.__typing = []
		let channel = new MessageChannel(), pending = []
		channel.port1.onmessage = () => {
			let t = pending.shift()
			if (t != null) window.__typing.push(performance.now() - t)
		}
		window.__benchKey = e => {
			let t0 = e.timeStamp
			requestAnimationFrame(() => {
				pending.push(t0)
				channel.port2.postMessage(null)
			})
		}
		document.addEventListener("keydown", window.__benchKey, true)
	})
	for (let ch of "const latency = measure(typing) // check it") {
		await page.keyboard.type(ch)
		await sleep(45)
	}
	await sleep(300)
	let typeCost = diff(typeStart, await metrics())
	let typing = await page.evaluate(() => {
		document.removeEventListener("keydown", window.__benchKey, true)
		return window.__typing
	})
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
	await page.evaluate(async () => {
		document.activeElement?.blur?.()
		await window.__benchFile.remove(true)
		window.__benchFile = null
	})
	await sleep(1500)

	return {
		config, cpu, textAt: Math.round(open.textAt), colorsAtOpen: Math.round(open.colorsAt), colorsAtEnd: Math.round(colorsAtEnd),
		heapMB: +heap.toFixed(1), fileHeapMB: +(heap - heapBefore).toFixed(1),
		movingFrames: moving.length, frameP50: +pct(moving, 0.5).toFixed(1), frameP95: +pct(moving, 0.95).toFixed(1),
		frameMax: +Math.max(0, ...moving).toFixed(1), blankFrames: fling.samples.filter(s => s.miss).length,
		longTasks: fling.longtasks.length, longTaskMax: Math.round(Math.max(0, ...fling.longtasks)), distances,
		flingBusyPerFrame: +(flingCost.task / Math.max(1, moving.length)).toFixed(2),
		flingLayoutStylePerFrame: +((flingCost.layout + flingCost.style) / Math.max(1, moving.length)).toFixed(2),
		typeP50: +pct(typing, 0.5).toFixed(1), typeP95: +pct(typing, 0.95).toFixed(1), typeN: typing.length,
		typeBusyPerKey: +(typeCost.task / Math.max(1, typing.length)).toFixed(2)
	}
}

let results = [], original = null
for (let config of configs) {
	let {current, backend} = await configure(config)
	original ??= current
	console.error(`config ${config}: editor backend ${backend}`)
	for (let cpu of cpus) {
		try {
			let r = {...await run(config, cpu), backend}
			results.push(r)
			console.log(JSON.stringify(r))
		} catch (e) {
			console.error(`failed: ${config} cpu=${cpu}: ${e.message}`)
			await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1}).catch(() => {})
		}
	}
}
if (original) {
	await page.evaluate(w => acode.require("settings").update(w, false), original)
	await page.reload({waitUntil: "domcontentloaded"}).catch(() => {})
}
await browser.disconnect()
await mkdir(resolve(import.meta.dirname, "results"), {recursive: true})
let file = resolve(import.meta.dirname, `results/acode-${lines}-${Date.now()}.json`)
await writeFile(file, JSON.stringify(results, null, 2))
let cols = ["config", "backend", "cpu", "textAt", "colorsAtOpen", "colorsAtEnd", "heapMB", "fileHeapMB", "frameP50", "frameP95", "frameMax",
	"blankFrames", "longTasks", "flingBusyPerFrame", "flingLayoutStylePerFrame", "typeP50", "typeP95", "typeBusyPerKey"]
console.log("\n| " + cols.join(" | ") + " |\n|" + cols.map(() => " --- ").join("|") + "|")
for (let r of results) console.log("| " + cols.map(c => r[c]).join(" | ") + " |")
console.log(`\nsaved ${file}`)
