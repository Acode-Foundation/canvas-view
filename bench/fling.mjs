// Fling benchmark: drives the demo pages in Chromium with mobile
// emulation, CPU throttling and real touch events over CDP, and
// compares canvas-view against stock CodeMirror 6.
//
//   node bench/fling.mjs [--cpu=1,4,6] [--impl=webgl2,webgpu,cm] [--lines=120000]
//                        [--kind=js] [--flings=6] [--browser=/path/to/chrome] [--headful]

import {createServer} from "node:http"
import {readFile, mkdir, writeFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import {homedir} from "node:os"
import puppeteer from "puppeteer-core"

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	let [k, v] = a.replace(/^--/, "").split("=")
	return [k, v ?? "true"]
}))
const cpus = (args.cpu ?? "1,4,6").split(",").map(Number)
const impls = (args.impl ?? "webgl2,webgpu,cm").split(",")
const lines = +(args.lines ?? 120000)
const kind = args.kind ?? "js"
const flings = +(args.flings ?? 6)
// Extra demo URL params for canvas runs, e.g. --query=wrap=1&ext=full
const browserPath = args.browser ?? join(homedir(),
	"Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
const root = resolve(import.meta.dirname, "../demo-dist")

const types = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
const server = createServer(async (req, res) => {
	let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
	if (path.endsWith("/")) path += "index.html"
	try {
		let body = await readFile(path)
		res.writeHead(200, {"content-type": types[extname(path)] ?? "application/octet-stream"})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
}).listen(0)
const port = server.address().port

const browser = await puppeteer.launch({
	executablePath: browserPath,
	headless: args.headful ? false : true,
	args: ["--enable-unsafe-webgpu", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--no-first-run"]
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (arr, p) => {
	if (!arr.length) return 0
	let s = [...arr].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

async function run(impl, cpu) {
	let page = await browser.newPage()
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
	let cdp = await page.createCDPSession()
	let url = impl == "cm"
		? `http://localhost:${port}/cm.html?kind=${kind}&lines=${lines}`
		: `http://localhost:${port}/index.html?kind=${kind}&lines=${lines}&backend=${impl}&bare=1${args.query ? "&" + args.query : ""}`
	await page.goto(url)
	await page.waitForFunction("window.ready === true", {timeout: 60000})
	let info = await page.evaluate(impl => {
		let c = document.createElement("canvas").getContext("webgl2")
		let dbg = c && c.getExtension("WEBGL_debug_renderer_info")
		return {
			createMs: window.createMs,
			renderer: dbg ? c.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?",
			backend: impl == "cm" ? "dom" : window.view.backend.kind
		}
	}, impl)
	await sleep(500)
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})

	// Sampling: every main-thread frame, plus long tasks.
	await page.evaluate(impl => {
		window.__samples = []
		window.__longtasks = []
		new PerformanceObserver(list => {
			for (let e of list.getEntries()) window.__longtasks.push(e.duration)
		}).observe({type: "longtask", buffered: false})
		let cm = window.cm, view = window.view
		if (view) {
			view.stats.length = 0
			view.recordStats = true
		}
		let loop = t => {
			let s = {t}
			if (cm) {
				let scroller = cm.scrollDOM, top = scroller.scrollTop, h = scroller.clientHeight
				let vpTop = cm.lineBlockAt(cm.viewport.from).top + cm.documentTop - scroller.getBoundingClientRect().top + top
				let vpBottom = cm.lineBlockAt(cm.viewport.to).bottom + cm.documentTop - scroller.getBoundingClientRect().top + top
				s.top = top
				s.miss = top < vpTop - 1 || top + h > vpBottom + 1
			} else {
				s.top = view.scrollTop
			}
			window.__samples.push(s)
			if (!window.__stop) requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	}, impl)

	let distances = []
	let touch = async (type, y) => cdp.send("Input.dispatchTouchEvent", {
		type, touchPoints: type == "touchEnd" ? [] : [{x: 206, y, radiusX: 4, radiusY: 4, force: 1, id: 1}]
	})
	let readTop = () => page.evaluate(() => window.cm ? window.cm.scrollDOM.scrollTop : window.view.scrollTop)
	for (let i = 0; i < flings + 2; i++) {
		let up = i >= flings
		let from = up ? 200 : 700, to = up ? 700 : 200
		let before = await readTop()
		await touch("touchStart", from)
		let steps = 12
		for (let k = 1; k <= steps; k++) {
			await sleep(8)
			await touch("touchMove", from + (to - from) * k / steps)
		}
		await touch("touchEnd", to)
		// Wait for momentum to settle.
		let last = await readTop(), still = 0
		for (let w = 0; w < 80 && still < 4; w++) {
			await sleep(60)
			let now = await readTop()
			still = Math.abs(now - last) < 0.5 ? still + 1 : 0
			last = now
		}
		distances.push(Math.round(last - before))
	}

	await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
	let data = await page.evaluate(() => {
		window.__stop = true
		return {samples: window.__samples, longtasks: window.__longtasks, stats: window.view ? window.view.stats : null}
	})
	await page.close()

	// Only frames during motion matter for smoothness.
	let moving = []
	for (let i = 1; i < data.samples.length; i++) {
		let a = data.samples[i - 1], b = data.samples[i]
		if (Math.abs(b.top - a.top) > 0.5) moving.push(b.t - a.t)
	}
	let result = {
		impl, backend: info.backend, cpu, renderer: info.renderer, createMs: Math.round(info.createMs),
		movingFrames: moving.length,
		frameP50: +pct(moving, 0.5).toFixed(1), frameP95: +pct(moving, 0.95).toFixed(1), frameMax: +Math.max(0, ...moving).toFixed(1),
		longTasks: data.longtasks.length, longTaskMax: Math.round(Math.max(0, ...data.longtasks)),
		distances
	}
	if (data.stats) {
		let s = data.stats.filter(f => f.work > 0)
		let lat = s.filter(f => f.latency >= 0).map(f => f.latency)
		Object.assign(result, {
			workP50: +pct(s.map(f => f.work), 0.5).toFixed(2), workP95: +pct(s.map(f => f.work), 0.95).toFixed(2),
			workMax: +Math.max(0, ...s.map(f => f.work)).toFixed(2),
			latencyP50: +pct(lat, 0.5).toFixed(1), latencyP95: +pct(lat, 0.95).toFixed(1),
			plainFrames: s.filter(f => f.plainLines > 0).length, approxFrames: s.filter(f => f.approxLines > 0).length,
			rebuilds: s.filter(f => f.rebuilt).length
		})
	} else {
		result.coverageMisses = data.samples.filter(s => s.miss).length
	}
	return result
}

let results = []
for (let cpu of cpus) {
	for (let impl of impls) {
		try {
			let r = await run(impl, cpu)
			results.push(r)
			console.log(JSON.stringify(r))
		} catch (e) {
			console.error(`failed: ${impl} cpu=${cpu}:`, e.message)
		}
	}
}
await browser.close()
server.close()

await mkdir(resolve(import.meta.dirname, "results"), {recursive: true})
let file = resolve(import.meta.dirname, `results/fling-${kind}-${lines}-${Date.now()}.json`)
await writeFile(file, JSON.stringify(results, null, 2))

let cols = ["impl", "cpu", "movingFrames", "frameP50", "frameP95", "frameMax", "workP95", "workMax", "latencyP50", "latencyP95", "longTasks", "plainFrames", "approxFrames", "coverageMisses"]
console.log("\n| " + cols.join(" | ") + " |\n|" + cols.map(() => " --- ").join("|") + "|")
for (let r of results) console.log("| " + cols.map(c => r[c] ?? "").join(" | ") + " |")
console.log(`\nrenderer: ${results[0]?.renderer}\nsaved ${file}`)
