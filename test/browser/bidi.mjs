// Browser test for bidirectional text: visual order compared with
// Chromium's own bidi (ICU) on real-world lines in all three paragraph
// directions, taps and clicks on right-to-left text, visual arrow-key
// motion, typing Hebrew, selections across direction changes (drawn
// pixels), right-aligned paragraphs, and that bidi costs nothing on
// left-to-right code and stays within budget while flinging RTL text.
// Run after `bun run demo:build`:
//
//   node test/browser/bidi.mjs [--backend=webgl2|webgpu] [--browser=path]

import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import {homedir} from "node:os"
import puppeteer from "puppeteer-core"
import {bidiFixtures, compareWithBrowser} from "./bidifixtures.mjs"

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	let [k, v] = a.replace(/^--/, "").split("=")
	return [k, v ?? "true"]
}))
const backend = args.backend ?? "webgl2"
const browserPath = args.browser ?? join(homedir(),
	"Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
const root = resolve(import.meta.dirname, "../../demo-dist")

const server = createServer(async (req, res) => {
	let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
	try {
		let body = await readFile(path)
		res.writeHead(200, {"content-type": {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[extname(path)] ?? "application/octet-stream"})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
}).listen(0)
const port = server.address().port
const browser = await puppeteer.launch({executablePath: browserPath, headless: true, args: ["--enable-unsafe-webgpu"]})
const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0, passes = 0
function check(name, ok, detail = "") {
	if (ok) passes++
	else failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
}

async function open(query) {
	let page = await browser.newPage()
	let errors = []
	page.on("pageerror", e => errors.push(e.message))
	page.on("console", m => { if (m.type() == "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
	await page.goto(`http://localhost:${port}/index.html?backend=${backend}&bare=1&${query}`)
	await page.waitForFunction("window.ready === true")
	await sleep(300)
	let cdp = await page.createCDPSession()
	let frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
	let tap = async (x, y) => {
		await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y, id: 1}]})
		await sleep(30)
		await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
		await frames()
	}
	let setDoc = (text, config = {}) => page.evaluate(async (text, config) => {
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: 0}})
		view.reconfigure({lineWrapping: false, textDirection: "ltr", ...config})
		view.scrollTop = 0
		view.scrollLeft = 0
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
	}, text, config)
	/// Client point at x (cells from the text start) on line 1.
	let point = (cells, line = 1) => page.evaluate((cells, line) => {
		let rect = view.scrollDOM.getBoundingClientRect(), from = view.state.doc.line(line).from
		let c = view.coordsAtPos(from, -1)
		return {x: rect.left + view.contentLeft + cells * view.cellWidth - view.scrollLeft, y: (c.top + c.bottom) / 2, top: c.top}
	}, cells, line)
	let sel = () => page.evaluate(() => ({head: view.state.selection.main.head, anchor: view.state.selection.main.anchor,
		assoc: view.state.selection.main.assoc}))
	/// x (cells from the text start) the main cursor is drawn at.
	let cursorCells = () => page.evaluate(() => {
		let m = view.state.selection.main, c = view.coordsAtPos(m.head, m.assoc)
		let rect = view.scrollDOM.getBoundingClientRect()
		return (c.left - rect.left - view.contentLeft + view.scrollLeft) / view.cellWidth
	})
	/// The cursor's drawn x from the screenshot (cursor-colored column).
	let drawnCursorX = async (x, top, bottom) => {
		await frames()
		let clip = {x: Math.max(0, x - 10), y: top + 2, width: 20, height: Math.max(4, bottom - top - 4)}
		let png = await page.screenshot({clip, encoding: "base64"})
		return page.evaluate(async (png, clipX) => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data
			let cols = []
			for (let x = 0; x < c.width; x++) {
				let hits = 0
				for (let y = 0; y < c.height; y++) {
					let i = (y * c.width + x) * 4
					if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) hits++
				}
				if (hits > c.height * 0.8) cols.push(x)
			}
			if (!cols.length) return null
			return clipX + (cols[0] + cols[cols.length - 1]) / 2 / (img.width / 20)
		}, png, clip.x)
	}
	/// Background color near the top of line 1 at x (cells), from a screenshot.
	let bgAt = async cells => {
		let p = await point(cells)
		let png = await page.screenshot({clip: {x: p.x - 1, y: p.top + 1, width: 2, height: 2}, encoding: "base64"})
		return page.evaluate(async png => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(Math.floor(img.width / 2), 0, 1, 1).data
			return [d[0], d[1], d[2]]
		}, png)
	}
	return {page, cdp, tap, frames, setDoc, point, sel, cursorCells, drawnCursorX, bgAt, errors}
}

// ---- Visual order: canvas-view vs Chromium -----------------------------------
{
	let t = await open("kind=rtl&lines=120&ext=basic")
	let generated = await t.page.evaluate(() => view.state.doc.toString().split("\n"))
	for (let mode of ["ltr", "rtl", "auto"]) {
		let a = await t.page.evaluate(compareWithBrowser, bidiFixtures, mode)
		check(`order matches Chromium: ${a.checked} real-world lines, ${mode}`, !a.mismatches.length, JSON.stringify(a.mismatches.slice(0, 2)))
		let b = await t.page.evaluate(compareWithBrowser, generated.slice(0, 60), mode)
		check(`order matches Chromium: rtl fixture (${b.checked} lines), ${mode}`, !b.mismatches.length, JSON.stringify(b.mismatches.slice(0, 2)))
	}
	check("no page errors (order)", !t.errors.length, t.errors.join("; "))
	await t.page.close()
}

// ---- Taps, clicks, arrows, typing, selection -----------------------------------
{
	let t = await open("kind=js&lines=50&ext=basic")
	let {page, tap, setDoc, point, sel, cursorCells, drawnCursorX, bgAt, frames} = t
	// "abc " | "שלום" drawn reversed in cells 4..8 | " def"
	await setDoc("abc שלום def")
	let drawn = await page.evaluate(() => {
		let vl = view.lines.vline(1)
		return {bidi: !!vl.bidi, runs: vl.bidi?.[0].runs.map(r => [r.from, r.to, r.level, r.x])}
	})
	check("mixed line gets bidi runs", drawn.bidi && drawn.runs.length == 3, JSON.stringify(drawn))

	// The right part of ש (cell 7) is the position before it.
	let p = await point(7.8)
	await tap(p.x, p.y)
	let s = await sel()
	check("tap on the right edge of ש: before it (4)", s.head == 4, JSON.stringify(s))
	let cx = await cursorCells()
	check("cursor before ש drawn at its right edge", Math.abs(cx - 8) < 0.05, String(cx))
	let px = await drawnCursorX(p.x, p.top, p.top + (await page.evaluate(() => view.lineHeight)))
	let want = (await point(8)).x
	check("cursor pixels at the right edge of ש", px != null && Math.abs(px - want) < 3, JSON.stringify({px, want}))
	p = await point(4.2)
	await tap(p.x, p.y)
	s = await sel()
	check("tap on the left edge of ם: after it (8)", s.head == 8, JSON.stringify(s))
	// The word's real advance isn't exactly 4 cells: click 40% from its
	// left edge, which is 60% into the word (2.4 chars), so position 6.
	let word = await page.evaluate(() => {
		let run = view.lines.vline(1).bidi[0].runs.find(r => r.level == 1)
		return {x: run.x, w: run.colTo - run.colFrom}
	})
	p = await point(word.x + word.w * 0.4)
	await page.mouse.click(p.x, p.y)
	await frames()
	s = await sel()
	check("click inside the word maps mirrored (6)", s.head == 6, JSON.stringify({s, word}))

	// Arrow keys move visually: x only grows, every position is visited.
	await page.evaluate(() => { view.dispatch({selection: {anchor: 0}}); view.focus() })
	let xs = [], heads = []
	for (let i = 0; i < 13; i++) {
		await page.keyboard.press("ArrowRight")
		await frames()
		xs.push(await cursorCells())
		heads.push((await sel()).head)
	}
	let monotonic = xs.every((x, i) => !i || x > xs[i - 1] - 0.01)
	check("ArrowRight moves visually left to right", monotonic && new Set(heads).size >= 12, JSON.stringify({heads, xs: xs.map(x => +x.toFixed(2))}))
	check("ArrowRight walks the Hebrew word backward logically", heads.slice(3, 8).join() == "4,7,6,5,8", heads.join())
	let back = []
	for (let i = 0; i < 13; i++) {
		await page.keyboard.press("ArrowLeft")
		await frames()
		back.push(await cursorCells())
	}
	check("ArrowLeft moves visually right to left", back.every((x, i) => !i || x < back[i - 1] + 0.01) && back[back.length - 1] < 0.05,
		JSON.stringify(back.map(x => +x.toFixed(2))))

	// Typing Hebrew after "abc ": the cursor follows the RTL word's left end.
	await setDoc("abc ")
	await page.evaluate(() => { view.dispatch({selection: {anchor: 4}}); view.focus() })
	await page.keyboard.sendCharacter("ש")
	await page.keyboard.sendCharacter("ל")
	await frames()
	s = await sel()
	let doc = await page.evaluate(() => view.state.doc.toString())
	check("typing Hebrew inserts logically", doc == "abc של" && s.head == 6, JSON.stringify({doc, s}))
	cx = await cursorCells()
	check("cursor after typed Hebrew is at the word's left end", Math.abs(cx - 4) < 0.05, String(cx))
	await page.keyboard.type(" x")
	doc = await page.evaluate(() => view.state.doc.toString())
	check("typing Latin after Hebrew", doc == "abc של x", doc)

	// Selection 2..6 = "c", " ", "ש", "ל": cells 2-3 and 6-7 are selected, 4-5 not.
	await setDoc("abc שלום def")
	await page.evaluate(() => view.dispatch({selection: {anchor: 2, head: 6}}))
	await frames()
	let plain = await bgAt(10.5), on = [], off = []
	for (let c of [2.5, 3.5, 6.5, 7.5]) on.push(await bgAt(c))
	for (let c of [4.5, 5.5, 0.5, 9.5]) off.push(await bgAt(c))
	let same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 6)
	check("selection across directions draws the selected cells", on.every(c => !same(c, plain)), JSON.stringify({plain, on}))
	check("selection leaves the other cells of the word", off.every(c => same(c, plain)), JSON.stringify({plain, off}))

	// Right-to-left paragraphs: right-aligned, "Hello" at the right.
	await setDoc("Hello עולם", {textDirection: "rtl"})
	let edge = await page.evaluate(() => {
		let rect = view.scrollDOM.getBoundingClientRect(), right = rect.left + view.contentLeft + view.lines.alignCols * view.cellWidth
		// Side -1 at the start / 1 at the end: the paragraph's visual edges.
		return {start: view.coordsAtPos(0, -1).left, end: view.coordsAtPos(10, 1).left, hello: view.coordsAtPos(0, 1).left,
			right, cw: view.cellWidth, dir: view.textDirectionAt(0)}
	})
	check("rtl paragraph starts at the right edge", Math.abs(edge.start - edge.right) < 1, JSON.stringify(edge))
	check("rtl paragraph ends 10 cells to its left", Math.abs(edge.right - edge.end - 10 * edge.cw) < 1 && edge.dir == 1, JSON.stringify(edge))
	check("the position before \"Hello\" is at its left edge", Math.abs(edge.right - edge.hello - 5 * edge.cw) < 1, JSON.stringify(edge))
	// From the paragraph's visual start (its right edge).
	await page.evaluate(() => {
		let ES = view.state.selection.constructor
		view.dispatch({selection: ES.create([ES.cursor(0, -1)])})
		view.focus()
	})
	let leftXs = [], leftHeads = new Set()
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press("ArrowLeft")
		await frames()
		leftXs.push(await cursorCells())
		leftHeads.add((await sel()).head)
	}
	check("ArrowLeft moves visually leftward through an rtl paragraph",
		leftXs.every((x, i) => !i || x < leftXs[i - 1] + 0.01) && leftHeads.size >= 10, JSON.stringify({leftXs, heads: [...leftHeads]}))

	// Auto: a Hebrew line is rtl, a code line stays ltr.
	await setDoc("// הערה\nconst x = 1", {textDirection: "auto"})
	let auto = await page.evaluate(() => [view.textDirectionAt(0), view.textDirectionAt(view.state.doc.line(2).from), !!view.lines.vline(2).bidi])
	check("auto: per-line direction, code lines skip bidi", auto.join() == "1,0,false", auto.join())
	check("no page errors (editing)", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Performance ---------------------------------------------------------------
{
	let t = await open("kind=js&lines=20000")
	let bidiLines = await t.page.evaluate(() => {
		let n = 0
		for (let i = 1; i <= 2000; i++) if (view.lines.vline(i).bidi) n++
		return n
	})
	check("left-to-right code: no line takes the bidi path", bidiLines == 0, String(bidiLines))
	await t.page.close()
	for (let dir of ["ltr", "auto", "rtl"]) {
		let r = await open(`kind=rtl&lines=20000&dir=${dir}&wrap=1`)
		let stats = await r.page.evaluate(async () => {
			view.recordStats = true
			view.stats.length = 0
			for (let i = 0; i < 3; i++) {
				view.fling(0, 6000)
				await new Promise(res => setTimeout(res, 1200))
			}
			let s = view.stats.splice(0).filter(f => f.scrollTop > 0)
			let work = s.map(f => f.work).sort((a, b) => a - b)
			return {frames: s.length, p95: work[Math.floor(work.length * 0.95)], max: work[work.length - 1], plain: s.filter(f => f.plainLines).length}
		})
		check(`fling through RTL text (${dir}, wrapped): JS work p95 ${stats.p95?.toFixed(2)}ms, max ${stats.max?.toFixed(2)}ms`,
			stats.frames > 30 && stats.p95 < 4 && stats.max < 12, JSON.stringify(stats))
		check(`no page errors (fling ${dir})`, !r.errors.length, r.errors.join("; "))
		await r.page.close()
	}
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
