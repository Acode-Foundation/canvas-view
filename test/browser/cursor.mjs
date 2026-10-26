// Browser test for cursor placement: real touch taps and mouse clicks
// (CDP input events) in Chromium with mobile emulation. Checks the
// resulting selection and that the cursor is drawn where coordsAtPos
// says. Run after `bun run demo:build`:
//
//   node test/browser/cursor.mjs [--backend=webgl2|webgpu] [--browser=path]

import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import {homedir} from "node:os"
import puppeteer from "puppeteer-core"

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
		res.writeHead(200, {"content-type": {".html": "text/html", ".js": "text/javascript"}[extname(path)] ?? "application/octet-stream"})
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

async function open(kind, lines) {
	let page = await browser.newPage()
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
	await page.goto(`http://localhost:${port}/index.html?kind=${kind}&lines=${lines}&backend=${backend}&bare=1`)
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
	let swipe = async (x, y1, y2, steps = 10) => {
		await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y: y1, id: 1}]})
		for (let i = 1; i <= steps; i++) {
			await sleep(8)
			await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: y1 + (y2 - y1) * i / steps, id: 1}]})
		}
		await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
	}
	let click = async (x, y) => {
		await page.mouse.click(x, y)
		await frames()
	}
	let head = () => page.evaluate(() => ({head: view.state.selection.main.head, empty: view.state.selection.main.empty}))
	/// Client coordinates a little inside the cell right of `pos`.
	let target = (pos, dx = 0.25) => page.evaluate(async (pos, dx) => {
		view.scrollPosIntoView(pos)
		await new Promise(r => requestAnimationFrame(r))
		let c = view.coordsAtPos(pos)
		return {x: c.left + view.cellWidth * dx, y: (c.top + c.bottom) / 2, left: c.left, top: c.top, bottom: c.bottom}
	}, pos, dx)
	/// Find the drawn cursor's x near `x` by scanning a screenshot strip.
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
					// The dark theme cursor is #528bff.
					if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) hits++
				}
				if (hits > c.height * 0.8) cols.push(x)
			}
			if (!cols.length) return null
			let scale = img.width / 20
			return clipX + (cols[0] + cols[cols.length - 1]) / 2 / scale
		}, png, clip.x)
	}
	let posOf = (line, needle, after = false) => page.evaluate((line, needle, after) => {
		let l = view.state.doc.line(line)
		let i = l.text.indexOf(needle)
		if (i < 0) throw new Error(`"${needle}" not in line ${line}: ${l.text}`)
		return l.from + i + (after ? needle.length : 0)
	}, line, needle, after)
	return {page, cdp, tap, swipe, click, head, target, drawnCursorX, posOf, frames}
}

// ---- Unicode fixture -------------------------------------------------------
{
	let t = await open("unicode", 400)
	let cases = [
		["ASCII word start", 1, "greeting0"],
		["after wide CJK text", 1, " 0\""],
		["before emoji", 2, "😀"],
		["after emoji", 2, "\", \"👩"],
		["before ZWJ emoji", 2, "👩🏽‍💻"],
		["after tab indentation", 2, "const emoji0"],
		["before Devanagari run", 3, "नमस्ते"],
		["after Devanagari run", 3, ": \"दुनिया"],
		// Drawn right to left: its start is the word's right edge, where
		// the text after the run begins (bidi): tap on the word's side.
		["before Arabic run", 3, "مرحبا", -0.25],
		["after Arabic run", 3, ": \"عالم"],
		["combining mark cluster", 3, "é"],
		["deep tab indentation", 4, "indented_with_tabs"]
	]
	for (let [name, line, needle, dx = 0.25] of cases) {
		let pos = await t.posOf(line, needle)
		let at = await t.target(pos, dx)
		// Neighbouring cases are a few positions apart: wait out the
		// double-tap interval so each is a single tap.
		await sleep(450)
		await t.tap(at.x, at.y)
		let h = await t.head()
		check(`tap: ${name}`, h.head == pos && h.empty, `expected ${pos}, got ${h.head}`)
		let drawn = await t.drawnCursorX(at.left, at.top, at.bottom)
		check(`cursor drawn: ${name}`, drawn != null && Math.abs(drawn - at.left) <= 2,
			`expected x≈${at.left.toFixed(1)}, drawn at ${drawn?.toFixed(1)}`)
		// Mouse click slightly left of the boundary lands on the same position.
		let left = await t.target(pos, -0.2)
		await t.click(left.x, left.y)
		let m = await t.head()
		check(`click: ${name}`, m.head == pos, `expected ${pos}, got ${m.head}`)
	}

	// Tap past the end of a line → line end.
	let line1 = await t.page.evaluate(() => {
		let l = view.state.doc.line(4)
		return {to: l.to}
	})
	let end = await t.target(line1.to)
	await t.tap(Math.min(405, end.x + 20), end.y)
	let h = await t.head()
	check("tap past line end → line end", h.head == line1.to, `expected ${line1.to}, got ${h.head}`)

	// Like CodeMirror (checked on a device), a tap on a line number with
	// nothing to fold doesn't move the cursor, and takes focus away.
	let l5 = await t.page.evaluate(() => view.state.doc.line(5).from)
	let g = await t.target(l5)
	let headBefore = (await t.head()).head
	await t.tap(8, g.y)
	h = await t.head()
	let focused = await t.page.evaluate(() => view.hasFocus)
	check("tap in gutter: cursor stays, no focus (like CodeMirror)", h.head == headBefore && !focused, `head ${h.head} (was ${headBefore}), focus ${focused}`)
	await t.page.close()
}

// ---- JS fixture: scrolled views, gestures -----------------------------------
{
	let t = await open("js", 20000)
	await t.page.evaluate(() => { view.scrollTop = view.lineTop(5000) + 7; view.scrollLeft = view.cellWidth * 6 })
	await t.frames()
	let pos = await t.posOf(5010, "(", true)
	let at = await t.target(pos)
	await t.tap(at.x, at.y)
	let h = await t.head()
	check("tap after vertical + horizontal scroll", h.head == pos, `expected ${pos}, got ${h.head}`)
	let drawn = await t.drawnCursorX(at.left, at.top, at.bottom)
	check("cursor drawn after scroll", drawn != null && Math.abs(drawn - at.left) <= 2, `expected ${at.left.toFixed(1)}, drawn ${drawn?.toFixed(1)}`)

	// A swipe scrolls but does not move the cursor.
	let before = await t.head()
	let top0 = await t.page.evaluate(() => view.scrollTop)
	await t.swipe(200, 600, 300)
	await t.frames()
	let after = await t.head()
	let top1 = await t.page.evaluate(() => view.scrollTop)
	check("swipe scrolls", top1 > top0 + 200, `scrollTop ${top0} → ${top1}`)
	check("swipe keeps the cursor", after.head == before.head, `${before.head} → ${after.head}`)

	// A tap during a fling stops the fling without moving the cursor.
	await t.swipe(200, 700, 200, 6)
	await t.frames()
	let flinging = await t.page.evaluate(() => view.scrolling)
	await t.tap(200, 400)
	let stoppedAt = await t.page.evaluate(() => view.scrollTop)
	await t.frames()
	let stillAt = await t.page.evaluate(() => view.scrollTop)
	let afterTap = await t.head()
	check("fling was running before the tap", flinging)
	check("tap stops the fling", Math.abs(stillAt - stoppedAt) < 1, `${stoppedAt} → ${stillAt}`)
	check("tap that stops a fling keeps the cursor", afterTap.head == before.head, `${before.head} → ${afterTap.head}`)

	// Flicking again along a fling adds to it (Android's flywheel); a
	// flick against it, or a finger held still on it, doesn't.
	let flingDistance = () => t.page.evaluate(() => view.scroller.flingY?.distance ?? 0)
	let reset = () => t.page.evaluate(async () => {
		view.scroller.cancelFling()
		view.scrollTop = view.lineTop(5000)
		await new Promise(r => requestAnimationFrame(r))
	})
	await reset()
	await t.swipe(200, 700, 400, 6)
	let single = await flingDistance()
	await t.frames()
	await t.swipe(200, 700, 400, 6)
	let boosted = await flingDistance()
	check("second flick adds to the fling", single > 0 && boosted > single * 1.5, `single ${single.toFixed(0)}, after second ${boosted.toFixed(0)}`)
	await reset()
	await t.swipe(200, 700, 400, 6)
	await t.frames()
	await t.swipe(200, 400, 700, 6)
	let reverse = await flingDistance()
	check("flick against a fling reverses it without boost", reverse < 0 && -reverse < single * 1.3, `single ${single.toFixed(0)}, reverse ${reverse.toFixed(0)}`)
	await reset()
	await t.swipe(200, 700, 400, 6)
	await t.frames()
	await t.cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 200, y: 500, id: 1}]})
	await sleep(120)
	let heldAt = await t.page.evaluate(() => view.scrollTop)
	await t.frames()
	let heldStill = await t.page.evaluate(() => ({top: view.scrollTop, scrolling: view.scrolling}))
	await t.cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
	await t.frames()
	check("finger held on a fling stops it", !heldStill.scrolling && Math.abs(heldStill.top - heldAt) < 1, `${heldAt} → ${heldStill.top}`)
	check("held finger on a fling doesn't move the cursor", (await t.head()).head == before.head)

	// Tap below the last line → document end.
	await t.page.evaluate(() => { view.scrollTop = view.maxScrollTop })
	await t.frames()
	await t.tap(300, 840)
	h = await t.head()
	let docEnd = await t.page.evaluate(() => view.state.doc.length)
	check("tap below last line → last line", await t.page.evaluate(h => view.state.doc.lineAt(h).number == view.state.doc.lines, h.head), `head ${h.head} of ${docEnd}`)

	// Mouse drag selects a range.
	await t.page.evaluate(() => { view.scrollTop = 0; view.scrollLeft = 0 })
	await t.frames()
	let a = await t.target(await t.posOf(1, "Section")), b = await t.target(await t.posOf(2, "fetchJSON"))
	await t.page.mouse.move(a.x, a.y)
	await t.page.mouse.down()
	await t.page.mouse.move(b.x, b.y, {steps: 5})
	await t.page.mouse.up()
	let sel = await t.page.evaluate(() => view.state.selection.main)
	let expectFrom = await t.posOf(1, "Section"), expectTo = await t.posOf(2, "fetchJSON")
	check("mouse drag selects range", sel.from == expectFrom && sel.to == expectTo, `${sel.from}-${sel.to} vs ${expectFrom}-${expectTo}`)
	await t.page.close()
}

// ---- Read-only and non-editable views ---------------------------------------
{
	let t = await open("js", 400)
	let roState = () => t.page.evaluate(() => ({focused: view.hasFocus, mode: view.contentDOM.inputMode}))
	let tapAt = async (line, needle) => {
		let pos = await t.posOf(line, needle), c = await t.target(pos)
		await t.tap(c.x, c.y)
		return {pos, c}
	}
	await tapAt(1, "Section")
	check("read-only: a writable view is focused by a tap", (await roState()).focused)
	await t.page.evaluate(() => view.dispatch({effects: cmApi.readOnlyCompartment.reconfigure(cmApi.EditorState.readOnly.of(true))}))
	await t.frames()
	let s = await roState()
	check("read-only: becoming read-only drops focus (closes the keyboard)", !s.focused && s.mode == "none", JSON.stringify(s))

	let {pos, c} = await tapAt(2, "fetchJSON")
	s = await roState()
	check("read-only: a tap focuses without a keyboard", s.focused && s.mode == "none", JSON.stringify(s))
	check("read-only: a tap moves the cursor", (await t.head()).head == pos)
	check("read-only: the cursor is drawn", await t.drawnCursorX(c.left, c.top, c.bottom) != null)

	await t.page.evaluate(() => view.dispatch({effects: cmApi.StateEffect.appendConfig.of(cmApi.EditorView.editable.of(false))}))
	;({pos, c} = await tapAt(1, "Section"))
	check("not editable: a tap moves the cursor without focus", (await t.head()).head == pos && !(await roState()).focused)
	let first = await t.drawnCursorX(c.left, c.top, c.bottom)
	await sleep(700)
	let second = await t.drawnCursorX(c.left, c.top, c.bottom)
	check("not editable: the cursor is drawn, without blinking", first != null && second != null, `${first} ${second}`)
	await t.page.evaluate(() => view.reconfigure({readOnlyCursor: false}))
	check("not editable: readOnlyCursor false hides it", await t.drawnCursorX(c.left, c.top, c.bottom) == null)

	let swapped = await t.page.evaluate(() => {
		let {EditorState} = cmApi
		view.setState(EditorState.create({doc: "writable\n"}))
		view.focus()
		let writable = view.contentDOM.inputMode, focused = view.hasFocus
		view.setState(EditorState.create({doc: "read only\n", extensions: EditorState.readOnly.of(true)}))
		return {writable, focused, readOnly: view.contentDOM.inputMode, stillFocused: view.hasFocus}
	})
	check("read-only: setState applies the new state's read-only mode", swapped.writable == "text" && swapped.readOnly == "none", JSON.stringify(swapped))
	check("read-only: switching to a read-only state drops focus", swapped.focused && !swapped.stillFocused, JSON.stringify(swapped))
	await t.page.close()
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
