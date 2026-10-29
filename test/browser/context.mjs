// Browser test for GPU context loss: the view must draw again, without
// any input, after a WebGL2 context is lost and restored, after one is
// lost for good (the canvas is replaced), and after WebGPU devices are
// lost (new device, then WebGL2 after repeated losses). Checks the drawn
// text and cursor pixels. Run after `bun run demo:build`:
//
//   node test/browser/context.mjs [--backend=webgl2|webgpu] [--browser=path]
//
// On a USB-connected Android device (dev server on 5173, `adb reverse
// tcp:5173 tcp:5173`, `adb forward tcp:9333 localabstract:chrome_devtools_remote`,
// a page open in the device browser):
//
//   node test/browser/context.mjs --device [--backend=webgpu]

import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import puppeteer from "puppeteer-core"
import {launch} from "../../bench/harness.mjs"

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	let [k, v] = a.replace(/^--/, "").split("=")
	return [k, v ?? "true"]
}))
const backend = args.backend ?? "webgl2"
const root = resolve(import.meta.dirname, "../../demo-dist")

const server = createServer(async (req, res) => {
	let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
	try {
		let body = await readFile(path)
		res.writeHead(200, {"content-type": {".html": "text/html", ".js": "text/javascript"}[extname(path)] ?? "application/octet-stream"})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
}).listen(0)
const device = args.device && (args.device == "true" ? "http://localhost:9333" : args.device)
const base = device ? "http://localhost:5173" : `http://localhost:${server.address().port}`
const browser = device ? await puppeteer.connect({browserURL: device, defaultViewport: null})
	: await launch(args)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0, passes = 0
function check(name, ok, detail = "") {
	if (ok) passes++
	else failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
}

let page
if (device) {
	page = (await browser.pages()).find(p => p.url().startsWith(base)) ?? (await browser.pages())[0]
	await page.bringToFront()
} else {
	page = await browser.newPage()
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
}
// No cursor blinking: a blink requests frames, which would hide a view
// that doesn't redraw by itself after a restore.
await page.goto(`${base}/index.html?kind=js&lines=2000&backend=${backend}&bare=1&blink=0`)
await page.waitForFunction("window.ready === true", {timeout: 60000})
await sleep(device ? 1500 : 300)
if (device) console.log(await page.evaluate(() => `${navigator.userAgent} dpr ${devicePixelRatio} ${innerWidth}x${innerHeight}`))
let cdp = await page.createCDPSession()
let frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

/// Run `fn(data, w, h)` on the pixels of `clip` (CSS px) in a screenshot.
/// The whole viewport is captured and cropped in the page: clipped
/// screenshots can show a stale (or, for a lost canvas, white) frame.
async function pixels(clip, fn) {
	await frames()
	let png = await page.screenshot({encoding: "base64"})
	return page.evaluate(async (png, clip, fn) => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let scale = img.width / innerWidth
		let c = document.createElement("canvas")
		c.width = Math.round(clip.width * scale)
		c.height = Math.round(clip.height * scale)
		let cx = c.getContext("2d")
		cx.drawImage(img, -Math.round(clip.x * scale), -Math.round(clip.y * scale))
		return new Function("d", "w", "h", fn)(cx.getImageData(0, 0, c.width, c.height).data, c.width, c.height)
	}, png, clip, fn)
}

/// Bright (text) pixels over the first lines of the text area.
let ink = () => pixels({x: 60, y: 10, width: 340, height: 200}, `
	let n = 0
	for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) > 140) n++
	return n`)

/// The drawn cursor's x near `at`, or null (the dark theme cursor is #528bff).
async function cursorX(at) {
	let clip = {x: Math.max(0, at.left - 10), y: at.top + 2, width: 20, height: Math.max(4, at.bottom - at.top - 4)}
	let x = await pixels(clip, `
		let cols = []
		for (let x = 0; x < w; x++) {
			let hits = 0
			for (let y = 0; y < h; y++) {
				let i = (y * w + x) * 4
				if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) hits++
			}
			if (hits > h * 0.8) cols.push(x)
		}
		return cols.length ? (cols[0] + cols[cols.length - 1]) / 2 / (w / 20) : null`)
	return x == null ? null : clip.x + x
}

let state = () => page.evaluate(() => ({kind: view.backend?.kind, lost: view.backend?.lost, recoveries: view.contextRecoveries,
	sameBackend: view.backend == window.oldBackend, sameCanvas: view.canvas == window.oldCanvas,
	oldCanvasAttached: window.oldCanvas?.isConnected, canvases: view.scrollDOM.querySelectorAll("canvas").length}))
let remember = () => page.evaluate(() => { window.oldBackend = view.backend; window.oldCanvas = view.canvas })

// Place the cursor with a tap (focuses the view).
let at = await page.evaluate(() => {
	let pos = view.state.doc.line(4).from + 3
	let c = view.coordsAtPos(pos)
	return {pos, x: c.left + view.cellWidth * 0.25, y: (c.top + c.bottom) / 2, left: c.left, top: c.top, bottom: c.bottom}
})
await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: at.x, y: at.y, id: 1}]})
await sleep(30)
await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
await frames()
await sleep(100)
let head = await page.evaluate(() => view.state.selection.main.head)
check("tap places the cursor", head == at.pos, `expected ${at.pos}, got ${head}`)
let baseline = await ink()
check("text drawn before any loss", baseline > 2000, `${baseline} bright pixels`)
let cx = await cursorX(at)
check("cursor drawn before any loss", cx != null && Math.abs(cx - at.left) <= 2, `expected ${at.left.toFixed(1)}, got ${cx}`)

/// Text and cursor are drawn as before, with no input since the loss.
async function drawnAgain(name) {
	let n = await ink()
	check(`${name}: text drawn again`, n > baseline * 0.9 && n < baseline * 1.1, `${n} bright pixels, ${baseline} before`)
	let x = await cursorX(at)
	check(`${name}: cursor drawn again`, x != null && Math.abs(x - at.left) <= 2, `expected ${at.left.toFixed(1)}, got ${x}`)
}

if (backend == "webgl2") {
	// Lost, then restored by the browser: same backend and canvas.
	await remember()
	await page.evaluate(() => { window.loseExt = view.canvas.getContext("webgl2").getExtension("WEBGL_lose_context"); loseExt.loseContext() })
	await sleep(200)
	let s = await state()
	check("WebGL2 loss is detected", s.lost === true, JSON.stringify(s))
	let n = await ink()
	check("nothing drawn while lost", n < baseline * 0.1, `${n} bright pixels`)
	await page.evaluate(() => loseExt.restoreContext())
	await sleep(400)
	s = await state()
	check("WebGL2 restore keeps the backend and canvas", s.lost === false && s.sameBackend && s.sameCanvas && s.recoveries == 0, JSON.stringify(s))
	await drawnAgain("WebGL2 restore")

	// Lost and never restored: the canvas is replaced after the timeout.
	await remember()
	await page.evaluate(() => view.canvas.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext())
	await sleep(1000)
	s = await state()
	check("WebGL2 waits for a restore first", s.lost === true && s.sameCanvas, JSON.stringify(s))
	await sleep(1600)
	s = await state()
	check("unrestored WebGL2 context: new canvas and backend", s.kind == "webgl2" && s.lost === false && !s.sameBackend &&
		!s.sameCanvas && !s.oldCanvasAttached && s.canvases == 1 && s.recoveries == 1, JSON.stringify(s))
	await drawnAgain("unrestored WebGL2 context")
} else {
	// A lost device is replaced right away by a new WebGPU backend.
	await remember()
	await page.evaluate(() => view.backend.device.destroy())
	await sleep(600)
	let s = await state()
	check("lost WebGPU device: new WebGPU backend", s.kind == "webgpu" && s.lost === false && !s.sameBackend &&
		!s.sameCanvas && s.canvases == 1 && s.recoveries == 1, JSON.stringify(s))
	await drawnAgain("lost WebGPU device")

	// Second loss: backs off (1s), still WebGPU.
	await page.evaluate(() => view.backend.device.destroy())
	await sleep(400)
	s = await state()
	check("repeated loss backs off", s.lost === true && s.recoveries == 1, JSON.stringify(s))
	await sleep(1000)
	s = await state()
	check("second WebGPU loss: WebGPU again", s.kind == "webgpu" && s.lost === false && s.recoveries == 2, JSON.stringify(s))
	await drawnAgain("second WebGPU loss")

	// Third loss (backs off 4s): settles for WebGL2.
	await page.evaluate(() => view.backend.device.destroy())
	await sleep(4600)
	s = await state()
	check("third WebGPU loss: falls back to WebGL2", s.kind == "webgl2" && s.lost === false && s.recoveries == 3 && s.canvases == 1, JSON.stringify(s))
	await drawnAgain("WebGL2 after WebGPU losses")
}

// The recovered view still scrolls and draws new lines.
let top = await page.evaluate(async () => {
	view.scrollTop = view.lineTop(800)
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
	return view.scrollTop
})
let n = await ink()
check("recovered view draws after scrolling", top > 0 && n > baseline * 0.5, `scrollTop ${top}, ${n} bright pixels`)

if (device) await browser.disconnect()
else await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
