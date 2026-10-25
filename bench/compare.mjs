// Compare canvas-view with CodeMirror 6, Ace and Monaco on the same
// fixture, emulated phone and inputs:
//  - touch flings: main-thread frame intervals while moving, long tasks
//  - typing: key event → end of the frame that shows it (measured the
//    same way for every editor: a rAF registered in a capturing keydown
//    listener, then a message posted after that frame)
//  - load time and JS heap after load
//  - syntax highlighting: when most visible lines have colors, after
//    load (from navigation start) and after jumping to the end of the file
// The CPU is throttled from the page load on, so load times scale too.
//
//   node bench/compare.mjs [--cpu=1,4,6] [--impl=canvas,webgpu,cm,ace,monaco] [--lines=120000]
//                          [--line=12] [--query=sticky=5]  (line typed on; extra demo URL params for canvas-view)
//
// --device runs on a USB-connected Android device, in the WebView of a
// debuggable app (navigated to the demo pages, served over adb reverse):
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//   node bench/compare.mjs --device [--port=5198]
// The app's page is left on the last demo page: restart the app afterwards.

import {execFileSync} from "node:child_process"
import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"
import puppeteer from "puppeteer-core"
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const device = !!args.device
const cpus = (args.cpu ?? "1,4,6").split(",").map(Number)
const impls = (args.impl ?? "canvas,cm,ace,monaco").split(",")
const lines = +(args.lines ?? 120000)
const typeLine = +(args.line ?? 12)
const server = await serveDemo(device ? +(args.port ?? 5198) : 0)
if (device) execFileSync("adb", ["reverse", `tcp:${new URL(server.url).port}`, `tcp:${new URL(server.url).port}`])
const browser = device
	? await puppeteer.connect({browserURL: args.device == "true" ? "http://localhost:9333" : args.device, defaultViewport: null})
	: await launch(args)
// A WebView can't open targets: every run navigates its one page.
const devicePage = device ? (await browser.pages())[0] : null
const deviceCdp = device ? await devicePage.createCDPSession() : null

const pages = {
	canvas: `index.html?kind=js&lines=${lines}&backend=webgl2&bare=1${args.query ? "&" + args.query : ""}`,
	webgpu: `index.html?kind=js&lines=${lines}&backend=webgpu&bare=1${args.query ? "&" + args.query : ""}`,
	cm: `cm.html?kind=js&lines=${lines}`,
	ace: `ace.html?kind=js&lines=${lines}`,
	monaco: `monaco.html?kind=js&lines=${lines}`
}

// Per-editor accessors, evaluated in the page.
const api = {
	top: {
		canvas: "view.scrollTop", cm: "cm.scrollDOM.scrollTop",
		ace: "aceEditor.session.getScrollTop()", monaco: "monacoEditor.getScrollTop()"
	},
	// True when the screen shows rows the editor hasn't rendered (blank
	// areas): only CM6, which leaves scrolling to the compositor. The
	// others scroll from JS and draw before showing a position.
	miss: {
		canvas: "false", ace: "false", monaco: "false",
		cm: `(() => {
			let s = cm.scrollDOM, top = s.scrollTop, h = s.clientHeight, base = cm.documentTop - s.getBoundingClientRect().top + top
			return top < cm.lineBlockAt(cm.viewport.from).top + base - 1 || top + h > cm.lineBlockAt(cm.viewport.to).bottom + base + 1
		})()`
	},
	toEnd: {
		canvas: "view.scrollTop = 1e9", cm: "cm.scrollDOM.scrollTop = 1e9",
		ace: "aceEditor.scrollToLine(aceEditor.session.getLength(), false, false)",
		monaco: "monacoEditor.revealLine(monacoEditor.getModel().getLineCount())"
	},
	toStart: {
		canvas: "view.scrollTop = 0", cm: "cm.scrollDOM.scrollTop = 0",
		ace: "aceEditor.scrollToLine(0, false, false)", monaco: "monacoEditor.setScrollTop(0)"
	},
	// [visible non-blank lines, of which colored]: a line counts as
	// colored when it's drawn with any token style.
	colored: {
		canvas: `(() => {
			let doc = view.state.doc, a = view.lineAtHeight(view.scrollTop), b = view.lineAtHeight(view.scrollTop + view.height)
			let n = 0, c = 0
			for (let i = a; i <= b; i++) {
				if (!doc.line(i).text.trim()) continue
				n++
				let seg = view.scene.segments.get(i)
				if (seg && seg.runs && seg.runs.length) c++
			}
			return [n, c]
		})()`,
		cm: "visibleLines(cm.scrollDOM, '.cm-line', 'span')",
		ace: "visibleLines(aceEditor.container, '.ace_text-layer .ace_line', 'span')",
		monaco: "visibleLines(monacoEditor.getDomNode(), '.view-lines .view-line', 'span[class*=mtk]:not(.mtk1)')"
	},
	// The line typed on (`--line`, default 12), scrolled to the middle of the screen.
	focusLine: {
		canvas: `(() => { let l = view.state.doc.line(${typeLine}); view.dispatch({selection: {anchor: l.to}}); view.scrollTop = view.lineTop(${typeLine}) - view.height / 2; view.focus() })()`,
		cm: `(() => { let l = cm.state.doc.line(${typeLine}); cm.dispatch({selection: {anchor: l.to}, scrollIntoView: true}); cm.focus() })()`,
		ace: `(() => { aceEditor.focus(); aceEditor.gotoLine(${typeLine}, 1000) })()`,
		monaco: `(() => { monacoEditor.focus(); monacoEditor.setPosition({lineNumber: ${typeLine}, column: 1000}); monacoEditor.revealLineInCenter(${typeLine}) })()`
	}
}

// WebGPU is the same canvas-view page.
for (let group of Object.values(api)) group.webgpu = group.canvas

const pct = (arr, p) => {
	if (!arr.length) return 0
	let s = [...arr].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const colorProbe = `
	window.visibleLines = (box, sel, token) => {
		let r = box.getBoundingClientRect(), n = 0, c = 0
		for (let el of box.querySelectorAll(sel)) {
			let e = el.getBoundingClientRect()
			if (e.bottom <= r.top || e.top >= r.bottom || !el.textContent.trim()) continue
			n++
			if (el.querySelector(token)) c++
		}
		return [n, c]
	}
	// Resolves with performance.now() once 60% of the visible non-blank
	// lines have colors (-1 after 60s).
	window.waitColored = expr => new Promise(resolve => {
		let read = new Function("return " + expr), t0 = performance.now()
		let poll = () => {
			let r = window.ready ? read() : [0, 0]
			if (r[0] > 0 && r[1] >= r[0] * 0.6) resolve(performance.now())
			else if (performance.now() - t0 > 60000) resolve(-1)
			else setTimeout(poll, 16)
		}
		poll()
	})`

async function run(impl, cpu) {
	let page = device ? devicePage : await phonePage(browser)
	let cdp = device ? deviceCdp : await page.createCDPSession()
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
	if (device) await page.goto("about:blank")
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
	await page.evaluateOnNewDocument(colorProbe)
	await page.goto(`${server.url}/${pages[impl]}`, {timeout: 180000})
	await page.waitForFunction("window.ready === true", {timeout: 180000, polling: 100})
	// Colors after load, from navigation start.
	let colorsAtLoad = await page.evaluate(expr => waitColored(expr), api.colored[impl])
	let createMs = await page.evaluate(() => window.createMs)
	await sleep(1500)
	// Jump to the end of the file: the worst case for highlighting.
	let colorsAtEnd = await page.evaluate((go, expr) => {
		let t0 = performance.now()
		new Function(go)()
		return waitColored(expr).then(t => t < 0 ? -1 : t - t0)
	}, api.toEnd[impl], api.colored[impl])
	await page.evaluate(new Function(api.toStart[impl]))
	await sleep(1500)
	await cdp.send("HeapProfiler.collectGarbage")
	let heap = (await cdp.send("Runtime.getHeapUsage")).usedSize
	await cdp.send("Performance.enable")
	// Main-thread time by phase (s): total task time, script, layout, style.
	let metrics = async () => {
		let m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(x => [x.name, x.value]))
		return {task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration}
	}
	let diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, (b[k] - a[k]) * 1000]))
	let flingStart = await metrics()

	// --- Flings ---
	await page.evaluate(top => {
		window.__samples = []
		window.__longtasks = []
		new PerformanceObserver(list => { for (let e of list.getEntries()) window.__longtasks.push(e.duration) })
			.observe({type: "longtask"})
		let read = new Function("return " + top[0]), miss = new Function("return " + top[1])
		let loop = t => {
			window.__samples.push({t, top: read(), miss: miss()})
			if (!window.__stop) requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	}, [api.top[impl], api.miss[impl]])
	let readTop = () => page.evaluate(new Function("return " + api.top[impl]))
	// The test swipe: 500px of an 860px-tall phone screen, scaled to the page.
	let size = await page.evaluate(() => [innerWidth, innerHeight])
	let touch = (type, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x: size[0] / 2, y: y * size[1] / 860, id: 1}]})
	let distances = []
	for (let i = 0; i < 8; i++) {
		let up = i >= 6, from = up ? 200 : 700, to = up ? 700 : 200
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

	// --- Typing ---
	await page.evaluate(new Function(api.focusLine[impl]))
	await sleep(300)
	let typeStart = await metrics()
	await page.evaluate(() => {
		window.__typing = []
		let channel = new MessageChannel()
		let pending = []
		channel.port1.onmessage = () => {
			let t = pending.shift()
			if (t != null) window.__typing.push(performance.now() - t)
		}
		document.addEventListener("keydown", e => {
			let t0 = e.timeStamp
			requestAnimationFrame(() => {
				// Runs after this frame's rendering work.
				pending.push(t0)
				channel.port2.postMessage(null)
			})
		}, true)
	})
	for (let ch of "const latency = measure(typing) // check it") {
		await page.keyboard.type(ch)
		await sleep(45)
	}
	await sleep(200)
	let typeCost = diff(typeStart, await metrics())
	let typing = await page.evaluate(() => window.__typing)
	let typedLongTasks = await page.evaluate(() => window.__longtasks.length)
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
	if (!device) await page.close()

	return {
		impl, cpu, createMs: Math.round(createMs), heapMB: +(heap / 1048576).toFixed(1),
		colorsAtLoad: Math.round(colorsAtLoad), colorsAtEnd: Math.round(colorsAtEnd),
		movingFrames: moving.length, frameP50: +pct(moving, 0.5).toFixed(1), frameP95: +pct(moving, 0.95).toFixed(1),
		frameMax: +Math.max(0, ...moving).toFixed(1), longTasks: fling.longtasks.length,
		blankFrames: fling.samples.filter(s => s.miss).length,
		longTaskMax: Math.round(Math.max(0, ...fling.longtasks)), distances,
		typing: typing.map(t => +t.toFixed(1)),
		typeP50: +pct(typing, 0.5).toFixed(1), typeP95: +pct(typing, 0.95).toFixed(1), typeN: typing.length, typedLongTasks,
		// Main-thread busy time per moving frame during flings, and per
		// keystroke while typing (ms), with the layout+style share.
		flingBusyPerFrame: +(flingCost.task / Math.max(1, moving.length)).toFixed(2),
		flingLayoutStylePerFrame: +((flingCost.layout + flingCost.style) / Math.max(1, moving.length)).toFixed(2),
		typeBusyPerKey: +(typeCost.task / Math.max(1, typing.length)).toFixed(2),
		typeLayoutStylePerKey: +((typeCost.layout + typeCost.style) / Math.max(1, typing.length)).toFixed(2)
	}
}

let results = []
for (let cpu of cpus) for (let impl of impls) {
	try {
		let r = await run(impl, cpu)
		results.push(r)
		console.log(JSON.stringify(r))
	} catch (e) {
		console.error(`failed: ${impl} cpu=${cpu}: ${e.message}`)
	}
}
if (device) await browser.disconnect()
else await browser.close()
server.close()
await mkdir(resolve(import.meta.dirname, "results"), {recursive: true})
let file = resolve(import.meta.dirname, `results/compare-${device ? "device-" : ""}${lines}-${Date.now()}.json`)
await writeFile(file, JSON.stringify(results, null, 2))
let cols = ["impl", "cpu", "createMs", "colorsAtLoad", "colorsAtEnd", "heapMB", "frameP50", "frameP95", "frameMax", "blankFrames", "longTasks", "flingBusyPerFrame", "flingLayoutStylePerFrame", "typeP50", "typeP95", "typeBusyPerKey", "typeLayoutStylePerKey"]
console.log("\n| " + cols.join(" | ") + " |\n|" + cols.map(() => " --- ").join("|") + "|")
for (let r of results) console.log("| " + cols.map(c => r[c]).join(" | ") + " |")
console.log(`\nsaved ${file}`)
