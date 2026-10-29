// Browser test in WebKit (Safari's engine, through Playwright), the
// closest headless stand-in for iOS: every iOS browser is WebKit. An
// iPhone context checks loading on the chosen backend, the textarea
// input path (WebKit has no EditContext), taps, double taps, long press,
// touch drags and flings, typing, bidi order against WebKit's own, and
// GPU context loss; a desktop Safari context checks mouse selection, the
// wheel and keyboard shortcuts. Run after `bun run demo:build`, with
// `bunx playwright install webkit` once:
//
//   node test/browser/webkit.mjs [--backend=webgl2|webgpu] [--browser=path]
//
// Playwright drives touch only through taps, so drags and long presses
// are synthetic pointer events. Those can't be captured (WebKit throws
// for a pointer id it doesn't know), so `setPointerCapture` ignores them.

import {webkit, devices} from "playwright"
import {parseArgs, serveDemo, sleep} from "../../bench/harness.mjs"
import {bidiFixtures, compareWithBrowser} from "./bidifixtures.mjs"

const args = parseArgs()
const backend = args.backend ?? "webgl2"
const server = await serveDemo()
const browser = await webkit.launch({executablePath: args.browser ?? process.env.WEBKIT_PATH})

let failures = 0, passes = 0
function check(name, ok, detail = "") {
	if (ok) passes++
	else failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
}

async function open(query, device = "iPhone 15") {
	let context = await browser.newContext(devices[device])
	let page = await context.newPage()
	let errors = []
	page.on("pageerror", e => errors.push(e.message))
	await page.addInitScript(() => {
		let capture = Element.prototype.setPointerCapture
		Element.prototype.setPointerCapture = function(id) {
			if (id >= 1000) return
			capture.call(this, id)
		}
	})
	// No cursor blinking, so screenshots always show the cursor.
	await page.goto(`${server.url}/index.html?${query}&backend=${backend}&blink=0`)
	await page.waitForFunction("window.ready === true", null, {timeout: 60000})
	await sleep(300)
	let frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
	let tap = async (x, y) => {
		await page.touchscreen.tap(x, y)
		await frames()
	}
	/// A synthetic touch: pointerdown at (x, y), moves along `path`
	/// (points 8ms apart), an optional hold, then pointerup. Returns the
	/// scroll position at the release, before a fling moves it.
	let touch = (x, y, path = [], hold = 0) => page.evaluate(async ([x, y, path, hold]) => {
		let fire = (type, x, y) => (document.elementFromPoint(x, y) ?? view.scrollDOM).dispatchEvent(new PointerEvent(type, {
			pointerId: 1001, pointerType: "touch", isPrimary: true, clientX: x, clientY: y,
			bubbles: true, cancelable: true, composed: true}))
		fire("pointerdown", x, y)
		if (hold) await new Promise(r => setTimeout(r, hold))
		for (let [px, py] of path) {
			await new Promise(r => setTimeout(r, 8))
			fire("pointermove", px, py)
			;[x, y] = [px, py]
		}
		let top = view.scrollDOM.scrollTop
		fire("pointerup", x, y)
		return top
	}, [x, y, path, hold])
	/// Client coordinates a little inside the cell right of `pos`.
	let target = (pos, dx = 0.25) => page.evaluate(async ([pos, dx]) => {
		view.scrollPosIntoView(pos)
		await new Promise(r => requestAnimationFrame(r))
		let c = view.coordsAtPos(pos)
		return {x: c.left + view.cellWidth * dx, y: (c.top + c.bottom) / 2, left: c.left, top: c.top, bottom: c.bottom}
	}, [pos, dx])
	let posOf = (line, needle) => page.evaluate(([line, needle]) => {
		let l = view.state.doc.line(line)
		let i = l.text.indexOf(needle)
		if (i < 0) throw new Error(`"${needle}" not in line ${line}: ${l.text}`)
		return l.from + i
	}, [line, needle])
	let sel = () => page.evaluate(() => {
		let {from, to, head} = view.state.selection.main
		return {from, to, head, text: view.state.sliceDoc(from, to)}
	})
	/// Run `fn(d, w, h)` on the pixels of `clip` (CSS px) in a screenshot
	/// of the whole viewport, cropped in the page.
	let pixels = async (clip, fn) => {
		await frames()
		let png = (await page.screenshot()).toString("base64")
		return page.evaluate(async ([png, clip, fn]) => {
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
		}, [png, clip, fn])
	}
	/// Bright (text) pixels over the top of the text area.
	let ink = () => pixels({x: 60, y: 10, width: 300, height: 200}, `
		let n = 0
		for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) > 140) n++
		return n`)
	/// The drawn cursor's x near `at`, or null (the dark theme cursor is #528bff).
	let cursorX = async at => {
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
	let close = () => context.close()
	return {page, errors, frames, tap, touch, target, posOf, sel, pixels, ink, cursorX, close}
}

// ---- Loading, taps, typing (iPhone) ------------------------------------------
{
	let t = await open("kind=unicode&lines=400&bare=1")
	let info = await t.page.evaluate(() => ({kind: view.backend?.kind, input: view.contentDOM.tagName, editContext: "EditContext" in window}))
	check(`loads on ${backend}`, info.kind == backend, JSON.stringify(info))
	check("textarea input without EditContext", info.input == "TEXTAREA" && !info.editContext, JSON.stringify(info))
	let n = await t.ink()
	check("text drawn", n > 1500, `${n} bright pixels`)

	let cases = [
		["ASCII word start", 1, "greeting0"],
		["after wide CJK text", 1, " 0\""],
		["before emoji", 2, "😀"],
		["before ZWJ emoji", 2, "👩🏽‍💻"],
		["after tab indentation", 2, "const emoji0"],
		["before Devanagari run", 3, "नमस्ते"],
		["combining mark cluster", 3, "e\u0301"]
	]
	for (let [name, line, needle] of cases) {
		let pos = await t.posOf(line, needle)
		let at = await t.target(pos)
		// Taps a few positions apart would count as a double tap.
		await sleep(350)
		await t.tap(at.x, at.y)
		let s = await t.sel()
		check(`tap: ${name}`, s.head == pos && s.from == s.to, `expected ${pos}, got ${JSON.stringify(s)}`)
		let x = await t.cursorX(at)
		check(`tap: ${name}: cursor drawn there`, x != null && Math.abs(x - at.left) <= 2, `expected ${at.left.toFixed(1)}, got ${x}`)
	}
	check("tap focuses the textarea", await t.page.evaluate(() => view.hasFocus && document.activeElement == view.contentDOM))

	let pos = await t.posOf(1, "greeting0")
	let at = await t.target(pos)
	await sleep(350)
	await t.tap(at.x, at.y)
	await t.page.keyboard.type("ab")
	await t.page.keyboard.press("Backspace")
	await t.page.keyboard.type("ç文")
	await t.frames()
	let line = await t.page.evaluate(() => view.state.doc.line(1).text)
	check("typing, Backspace and non-ASCII text", line.includes("aç文greeting0"), line)
	await t.page.keyboard.press("Enter")
	await t.frames()
	let s = await t.page.evaluate(() => ({lines: view.state.doc.lines, head: view.state.selection.main.head, l2: view.state.doc.line(2).text}))
	check("Enter splits the line", s.l2.trimStart().startsWith("greeting0") && s.lines == 401, JSON.stringify(s))
	await t.page.keyboard.press("ArrowLeft")
	let h = await t.page.evaluate(() => view.state.selection.main.head)
	check("ArrowLeft moves the cursor", h < s.head, `${s.head} → ${h}`)
	check("no page errors (taps, typing)", !t.errors.length, t.errors.join("; "))
	await t.close()
}

// ---- Touch selection, drags and flings (iPhone) -------------------------------
{
	let t = await open("kind=js&lines=2000&bare=1")
	let word = await t.page.evaluate(() => {
		for (let n = 1; n <= 40; n++) {
			let text = view.state.doc.line(n).text, m = /[A-Za-z_]\w{5,}/.exec(text)
			if (m) return {pos: view.state.doc.line(n).from + m.index + 2, text: m[0]}
		}
	})
	let at = await t.target(word.pos)
	await t.tap(at.x, at.y)
	await sleep(60)
	await t.tap(at.x, at.y)
	await sleep(50)
	let s = await t.sel()
	check("double tap selects the word", s.text == word.text, JSON.stringify(s))

	await sleep(400)
	await t.tap(10, 700)
	await sleep(400)
	await t.touch(at.x, at.y, [], 600)
	await t.frames()
	s = await t.sel()
	check("long press selects the word", s.text == word.text, JSON.stringify(s))
	await sleep(400)

	let top0 = await t.page.evaluate(() => view.scrollDOM.scrollTop)
	let path = []
	for (let i = 1; i <= 10; i++) path.push([200, 600 - i * 30])
	let top1 = await t.touch(200, 600, path)
	// The move crossing the touch slop starts the drag without moving it.
	check("touch drag follows the finger", Math.abs(top1 - top0 - 270) < 2, `${top0} → ${top1}`)
	await sleep(500)
	let top2 = await t.page.evaluate(() => view.scrollDOM.scrollTop)
	check("release flings on", top2 > top1 + 100, `${top1} → ${top2}`)
	let n = await t.ink()
	check("text drawn after the fling", n > 1500, `${n} bright pixels`)
	let drawn = await t.page.evaluate(() => view.debug.coverage)
	check("visible lines colored after the fling", drawn.plain == 0, JSON.stringify(drawn))
	check("no page errors (touch)", !t.errors.length, t.errors.join("; "))
	await t.close()
}

// ---- Bidi order: canvas-view vs WebKit ----------------------------------------
{
	let t = await open("kind=rtl&lines=120&ext=basic")
	let generated = await t.page.evaluate(() => view.state.doc.toString().split("\n"))
	let compare = (lines, mode) => t.page.evaluate(`(${compareWithBrowser})(${JSON.stringify(lines)}, ${JSON.stringify(mode)})`)
	for (let mode of ["ltr", "rtl", "auto"]) {
		let a = await compare(bidiFixtures, mode)
		check(`order matches WebKit: ${a.checked} real-world lines, ${mode}`, !a.mismatches.length, JSON.stringify(a.mismatches.slice(0, 2)))
		let b = await compare(generated.slice(0, 60), mode)
		check(`order matches WebKit: rtl fixture (${b.checked} lines), ${mode}`, !b.mismatches.length, JSON.stringify(b.mismatches.slice(0, 2)))
	}
	check("no page errors (bidi)", !t.errors.length, t.errors.join("; "))
	await t.close()
}

// ---- GPU context loss (iPhone: Safari loses contexts in the background) --------
{
	let t = await open("kind=js&lines=2000&bare=1")
	let pos = await t.page.evaluate(() => view.state.doc.line(4).from + 3)
	let at = await t.target(pos)
	await t.tap(at.x, at.y)
	let baseline = await t.ink()
	let state = () => t.page.evaluate(() => ({kind: view.backend?.kind, lost: view.backend?.lost, recoveries: view.contextRecoveries}))
	let drawnAgain = async name => {
		let n = await t.ink()
		check(`${name}: text drawn again`, n > baseline * 0.9 && n < baseline * 1.1, `${n} bright pixels, ${baseline} before`)
		let x = await t.cursorX(at)
		check(`${name}: cursor drawn again`, x != null && Math.abs(x - at.left) <= 2, `expected ${at.left.toFixed(1)}, got ${x}`)
	}
	if (backend == "webgl2") {
		await t.page.evaluate(() => { window.loseExt = view.canvas.getContext("webgl2").getExtension("WEBGL_lose_context"); loseExt.loseContext() })
		await sleep(200)
		check("WebGL2 loss is detected", (await state()).lost === true, JSON.stringify(await state()))
		await t.page.evaluate(() => loseExt.restoreContext())
		await sleep(400)
		check("WebGL2 restore keeps the backend", (await state()).recoveries == 0, JSON.stringify(await state()))
		await drawnAgain("WebGL2 restore")
	} else {
		await t.page.evaluate(() => view.backend.device.destroy())
		await sleep(1500)
		let s = await state()
		check("lost WebGPU device: new backend", s.kind == "webgpu" && s.lost === false && s.recoveries == 1, JSON.stringify(s))
		await drawnAgain("lost WebGPU device")
	}
	check("no page errors (context loss)", !t.errors.length, t.errors.join("; "))
	await t.close()
}

// ---- Mouse, wheel and shortcuts (desktop Safari) ------------------------------
{
	let t = await open("kind=js&lines=2000&bare=1", "Desktop Safari")
	let a = await t.target(await t.page.evaluate(() => view.state.doc.line(3).from + 2))
	let b = await t.target(await t.page.evaluate(() => view.state.doc.line(6).from + 5))
	await t.page.mouse.click(a.x, a.y)
	await t.frames()
	let s = await t.sel()
	let pos = await t.page.evaluate(() => view.state.doc.line(3).from + 2)
	check("click places the cursor", s.head == pos && s.from == s.to, `expected ${pos}, got ${JSON.stringify(s)}`)
	let x = await t.cursorX(a)
	check("click: cursor drawn there", x != null && Math.abs(x - a.left) <= 2, `expected ${a.left.toFixed(1)}, got ${x}`)
	// Past the double-click interval, or the press selects by word.
	await sleep(600)
	await t.page.mouse.move(a.x, a.y)
	await t.page.mouse.down()
	await t.page.mouse.move(b.x, b.y, {steps: 5})
	await t.page.mouse.up()
	await t.frames()
	s = await t.sel()
	let end = await t.page.evaluate(() => view.state.doc.line(6).from + 5)
	check("mouse drag selects", s.from == pos && s.to == end, `expected ${pos}-${end}, got ${JSON.stringify(s)}`)

	let mod = await t.page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control")
	await t.page.keyboard.press(`${mod}+a`)
	s = await t.sel()
	let len = await t.page.evaluate(() => view.state.doc.length)
	check(`${mod}-a selects everything`, s.from == 0 && s.to == len, JSON.stringify({from: s.from, to: s.to, len}))
	await t.page.mouse.click(a.x, a.y)
	await t.page.keyboard.type("xy")
	await t.page.keyboard.press(`${mod}+z`)
	await t.frames()
	let line = await t.page.evaluate(() => view.state.doc.line(3).text)
	check(`${mod}-z undoes typing`, !line.includes("xy"), line)

	await t.page.mouse.move(200, 300)
	await t.page.mouse.wheel(0, 600)
	await sleep(200)
	let top = await t.page.evaluate(() => view.scrollDOM.scrollTop)
	check("wheel scrolls", top > 300, `scrollTop ${top}`)
	let n = await t.ink()
	check("text drawn after the wheel", n > 1500, `${n} bright pixels`)
	check("no page errors (desktop)", !t.errors.length, t.errors.join("; "))
	await t.close()
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (webkit ${backend})`)
process.exit(failures ? 1 : 0)
