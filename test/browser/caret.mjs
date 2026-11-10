// Browser tests for the cursor's look and motion: cursor styles (drawn
// pixels), the smooth caret slide, animated blinking, smooth scrolling
// for keys and commands, and @replit/codemirror-vim (its mode picks the
// drawn cursor shape; its keys, including virtual-keyboard ones, run).
//
//   node test/browser/caret.mjs [--backend=webgl2|webgpu]

import {launch, parseArgs, serveDemo, sleep} from "../../bench/harness.mjs"

const args = parseArgs()
const backend = args.backend ?? "webgl2"
const server = await serveDemo()
const browser = await launch(args)

let failures = 0, passes = 0
function check(name, ok, detail = "") {
	if (ok) passes++
	else failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
}

const page = await browser.newPage()
await page.setViewport({width: 900, height: 600, deviceScaleFactor: 2})
async function open(query = "") {
	await page.goto(`${server.url}/index.html?kind=js&lines=2000&backend=${backend}&bare=1&ext=basic&blink=0${query}`)
	await page.waitForFunction("window.ready === true")
	await sleep(300)
}
const frames = (n = 2) => page.evaluate(n => new Promise(r => {
	let step = () => --n ? requestAnimationFrame(step) : r()
	requestAnimationFrame(step)
}), n)
/// The cursor instances as drawn: rects (x, y, w, h, alpha) and glyph count.
const cursor = () => page.evaluate(() => {
	let b = view.cursorRects, rects = []
	for (let i = 0; i < b.count; i++) {
		let at = i * 5
		rects.push({x: b.f32[at], y: b.f32[at + 1], w: b.f32[at + 2], h: b.f32[at + 3], a: b.u32[at + 4] >>> 24})
	}
	return {rects, glyphs: view.cursorGlyphs.count, cw: view.cellWidth, lh: view.lineHeight}
})
/// Fraction of the cell at `pos` (device pixels) in the cursor color.
const cursorCoverage = async pos => {
	await frames()
	let c = await page.evaluate(pos => {
		let r = view.coordsAtPos(pos)
		return {x: r.left, y: r.top, w: view.cellWidth, h: r.bottom - r.top}
	}, pos)
	let png = await page.screenshot({clip: {x: c.x + 1, y: c.y + 1, width: c.w - 2, height: c.h - 2}, encoding: "base64"})
	return page.evaluate(async png => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let cv = document.createElement("canvas")
		cv.width = img.width
		cv.height = img.height
		let cx = cv.getContext("2d")
		cx.drawImage(img, 0, 0)
		let d = cx.getImageData(0, 0, cv.width, cv.height).data, hits = 0
		// The dark theme's cursor, #528bff.
		for (let i = 0; i < d.length; i += 4)
			if (Math.abs(d[i] - 0x52) < 24 && Math.abs(d[i + 1] - 0x8b) < 24 && Math.abs(d[i + 2] - 0xff) < 24) hits++
		return hits / (d.length / 4)
	}, png)
}

// ---- Cursor styles ----------------------------------------------------------
await open()
await page.evaluate(() => { view.focus(); view.dispatch({selection: {anchor: view.state.doc.line(2).from + 2}}) })
await frames()
{
	let pos = await page.evaluate(() => view.state.selection.main.head)
	let c = await cursor()
	check("line (default): one 2px bar, a line tall", c.rects.length == 1 && c.rects[0].w == 2 && Math.abs(c.rects[0].h - c.lh) < 0.01 && c.glyphs == 0, JSON.stringify(c))
	let line = await cursorCoverage(pos)
	for (let [style, test] of [
		["line-thin", c => c.rects.length == 1 && c.rects[0].w == 1],
		["block", c => c.rects.length == 1 && Math.abs(c.rects[0].w - c.cw) < 0.01 && Math.abs(c.rects[0].h - c.lh) < 0.01 && c.glyphs == 1],
		["block-outline", c => c.rects.length == 4 && c.glyphs == 0],
		["underline", c => c.rects.length == 1 && c.rects[0].h == 2 && Math.abs(c.rects[0].w - c.cw) < 0.01],
		["underline-thin", c => c.rects.length == 1 && c.rects[0].h == 1]
	]) {
		await page.evaluate(style => view.reconfigure({cursorStyle: style}), style)
		await frames()
		let got = await cursor()
		check(`${style}: geometry`, test(got), JSON.stringify(got))
	}
	await page.evaluate(() => view.reconfigure({cursorStyle: "block"}))
	let block = await cursorCoverage(pos)
	check("block: fills the cell with the cursor color (drawn)", block > 0.4 && block > line * 3, JSON.stringify({block, line}))
	// The character over it is drawn in the background color: part of
	// the cell isn't cursor-colored.
	check("block: the character shows through", block < 0.97, JSON.stringify({block}))
	await page.evaluate(() => view.dispatch({changes: {from: 0, insert: "中x\n"}, selection: {anchor: 0}}))
	await frames()
	let c2 = await cursor()
	check("block: as wide as a wide character", c2.rects.length == 1 && c2.rects[0].w > c2.cw * 1.5, JSON.stringify(c2))
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(1).to}}))
	await frames()
	c2 = await cursor()
	check("block: one cell at the line end", c2.rects.length == 1 && Math.abs(c2.rects[0].w - c2.cw) < 0.01 && c2.glyphs == 0, JSON.stringify(c2))
	await page.evaluate(() => view.reconfigure({cursorStyle: "line"}))
}

// ---- Smooth caret -----------------------------------------------------------
{
	const caret = () => page.evaluate(() => ({x: view.caretOffset.x, y: view.caretOffset.y, anim: !!view.caretAnim}))
	const statsDuring = async f => {
		await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
		await f()
		return page.evaluate(() => { view.recordStats = false; return view.stats.map(s => ({rebuilt: s.rebuilt, sceneMs: s.sceneMs})) })
	}
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(5).from}}))
	await frames()
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(9).from + 6}, scrollIntoView: true}))
	await frames()
	let c = await caret()
	check("caret off (default): moves at once", c.x == 0 && c.y == 0 && !c.anim, JSON.stringify(c))

	await page.evaluate(() => view.reconfigure({cursorSmoothCaretAnimation: "on"}))
	let stats = await statsDuring(async () => {
		await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(5).from}}))
		await frames(1)
		c = await caret()
		await sleep(150)
		await frames()
	})
	check("caret on: slides from where it was", c.anim && c.y > 0 && c.x > 0, JSON.stringify(c))
	let after = await caret()
	check("caret on: ends at the new position", after.x == 0 && after.y == 0 && !after.anim, JSON.stringify(after))
	// The first frame applies the selection change; the slide's frames
	// after it only move the cursor pass.
	check("caret on: the slide rebuilds no scene", stats.length > 2 && stats.slice(1).every(s => !s.rebuilt), JSON.stringify(stats))

	await page.evaluate(() => view.reconfigure({cursorSmoothCaretAnimation: "explicit"}))
	await page.keyboard.type("ab")
	await frames(1)
	c = await caret()
	check("caret explicit: typing doesn't slide", !c.anim && c.x == 0, JSON.stringify(c))
	await page.keyboard.press("ArrowDown")
	await frames(1)
	c = await caret()
	check("caret explicit: an arrow key slides", c.anim && c.y < 0, JSON.stringify(c))
	await sleep(150)
	await page.evaluate(() => {
		let S = view.state.selection.constructor, d = view.state.doc
		view.dispatch({selection: S.create([S.cursor(d.line(3).from), S.cursor(d.line(7).from)])})
	})
	await frames()
	await page.keyboard.press("ArrowDown")
	await frames(1)
	c = await caret()
	check("caret: several cursors don't slide", !c.anim && c.x == 0 && c.y == 0, JSON.stringify(c))
	await page.evaluate(() => view.reconfigure({cursorSmoothCaretAnimation: "off"}))
}

// ---- Animated blinking ------------------------------------------------------
{
	const alphas = async (ms, step = 20) => {
		let out = []
		for (let t = 0; t < ms; t += step) {
			out.push(await page.evaluate(() => view.cursorRects.u32[4] >>> 24))
			await sleep(step)
		}
		return out
	}
	await page.evaluate(() => view.reconfigure({cursorBlinkRate: 600, cursorBlinking: "smooth"}))
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(3).from}}))
	let a = await alphas(700)
	let mid = a.filter(x => x > 10 && x < 245).length
	check("smooth blink: fades through partial opacity", mid >= 3 && a.some(x => x < 10) && a.some(x => x > 245), JSON.stringify(a))
	await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
	await sleep(1200)
	let n = await page.evaluate(() => { view.recordStats = false; return view.stats.length })
	// Two blinks of 600ms: fades are 40% of a period (24 frames at 60Hz each),
	// the plateaus draw nothing.
	check("smooth blink: frames only while fading", n > 5 && n < 72 * 0.75, String(n))
	await page.evaluate(() => view.reconfigure({cursorBlinking: "expand"}))
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(4).from}}))
	let hs = []
	for (let t = 0; t < 600; t += 20) {
		hs.push(await page.evaluate(() => view.cursorRects.f32[3]))
		await sleep(20)
	}
	let lh = await page.evaluate(() => view.lineHeight)
	check("expand blink: the height shrinks and grows", hs.some(h => h > 0.1 && h < lh - 0.5) && hs.some(h => Math.abs(h - lh) < 0.01), JSON.stringify(hs.map(h => +h.toFixed(1))))
	await page.evaluate(() => view.reconfigure({cursorBlinking: "solid"}))
	await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
	await sleep(700)
	n = await page.evaluate(() => { view.recordStats = false; return view.stats.length })
	let alpha = await page.evaluate(() => view.cursorRects.u32[4] >>> 24)
	check("solid: no frames while idle, full opacity", n <= 1 && alpha == 255, JSON.stringify({n, alpha}))
	await page.evaluate(() => view.reconfigure({cursorBlinking: "blink", cursorBlinkRate: 0}))
}

// ---- Smooth scrolling -------------------------------------------------------
{
	const goTo = line => page.evaluate(line => {
		let pos = view.state.doc.line(line).from
		view.dispatch({selection: {anchor: pos}, effects: window.cmApi.EditorView.scrollIntoView(pos, {y: "center"})})
	}, line)
	await page.evaluate(() => { view.scrollTop = 0 })
	await frames()
	await goTo(400)
	let instant = await page.evaluate(() => ({top: view.scrollTop, anim: !!view.scrollAnim}))
	check("smoothScrolling off (default): jumps at once", instant.top > 0 && !instant.anim, JSON.stringify(instant))
	let target = instant.top

	await page.evaluate(() => { view.reconfigure({smoothScrolling: true}); view.scrollTop = 0 })
	await frames()
	let tops = await page.evaluate(() => new Promise(r => {
		view.stats.length = 0
		view.recordStats = true
		let pos = view.state.doc.line(400).from, out = [view.scrollTop]
		view.dispatch({selection: {anchor: pos}, effects: window.cmApi.EditorView.scrollIntoView(pos, {y: "center"})})
		out.push(view.scrollTop)
		let step = () => {
			out.push(view.scrollTop)
			if (view.scrollAnim || out.length < 4) requestAnimationFrame(step)
			else { view.recordStats = false; r(out) }
		}
		requestAnimationFrame(step)
	}))
	let vh = await page.evaluate(() => view.visibleHeight)
	let last = tops[tops.length - 1]
	check("smooth scroll: ends at the same place", Math.abs(last - target) < 0.5, JSON.stringify({last, target}))
	check("smooth scroll: a long jump only glides the last 1.5 screens", Math.abs(tops[1] - target) <= vh * 1.5 + 1 && tops[1] > 0, JSON.stringify(tops.slice(0, 3)))
	let increasing = tops.slice(1).every((t, i, a) => i == 0 || t >= a[i - 1] - 0.01)
	check("smooth scroll: moves monotonically in steps", increasing && new Set(tops.map(Math.round)).size > 3, JSON.stringify(tops.map(Math.round)))

	// PageDown (defaultKeymap's cursorPageDown) glides too.
	await page.evaluate(() => { view.scrollTop = 0; view.dispatch({selection: {anchor: 0}}); view.focus() })
	await frames()
	await page.keyboard.press("PageDown")
	let pd = await page.evaluate(() => ({top: view.scrollTop, anim: !!view.scrollAnim, to: view.scrollAnim?.toTop}))
	check("smooth scroll: PageDown animates", pd.anim && pd.to > pd.top, JSON.stringify(pd))
	// A wheel takes over.
	await page.mouse.move(400, 300)
	await page.mouse.wheel({deltaY: 40})
	await frames()
	check("smooth scroll: the wheel stops it", !(await page.evaluate(() => !!view.scrollAnim)))
	await page.evaluate(() => view.reconfigure({smoothScrolling: false}))
}

// ---- Vim --------------------------------------------------------------------
await open("&vim=1")
{
	const vim = () => page.evaluate(() => {
		let cm = cmApi.getCM(view)
		return {insert: !!cm.state.vim.insertMode, visual: !!cm.state.vim.visualMode, head: view.state.selection.main.head,
			anchor: view.state.selection.main.anchor, line: view.state.doc.line(2).text}
	})
	let line2 = await page.evaluate(() => { view.focus(); let l = view.state.doc.line(2); view.dispatch({selection: {anchor: l.from}}); return l.text })
	await frames()
	let c = await cursor()
	check("vim normal mode: a block cursor with the character", c.rects.length == 1 && Math.abs(c.rects[0].w - c.cw) < 0.01 && c.glyphs == 1, JSON.stringify(c))
	check("vim: its DOM cursor layer is hidden", await page.evaluate(() => getComputedStyle(document.querySelector(".cm-vimCursorLayer")).display) == "none")
	await page.keyboard.press("w")
	let v = await vim()
	check("vim: w moves by word", v.head == await page.evaluate(() => view.state.doc.line(2).from) + line2.indexOf(" ") + 1 && v.line == line2, JSON.stringify(v))
	await page.keyboard.press("x")
	v = await vim()
	check("vim: x deletes a character", v.line.length == line2.length - 1, JSON.stringify(v))
	await page.keyboard.press("u")
	check("vim: u undoes", (await vim()).line == line2)
	await page.keyboard.press("i")
	await frames()
	c = await cursor()
	v = await vim()
	check("vim insert mode: a line cursor", v.insert && c.rects.length == 1 && c.rects[0].w == 2 && c.glyphs == 0, JSON.stringify([v, c]))
	await page.keyboard.type("Q")
	check("vim insert mode: typing inserts", (await vim()).line.includes("Q"))
	await page.keyboard.press("Escape")
	await frames()
	c = await cursor()
	v = await vim()
	check("vim: Escape returns to a block cursor", !v.insert && c.rects.length == 1 && Math.abs(c.rects[0].w - c.cw) < 0.01, JSON.stringify([v, c]))
	await page.keyboard.press("u")
	await page.keyboard.press("0")
	await page.keyboard.press("v")
	await page.keyboard.press("l")
	await page.keyboard.press("l")
	await frames()
	v = await vim()
	c = await cursor()
	let x2 = await page.evaluate(h => { let r = view.coordsAtPos(h - 1), s = view.scrollDOM.getBoundingClientRect(); return r.left - s.left - view.contentLeft + view.scrollLeft }, v.head)
	check("vim visual mode: the block is on the last selected character", v.visual && v.head - v.anchor == 3 &&
		c.rects.length == 1 && Math.abs(c.rects[0].x - x2) < 0.5, JSON.stringify([v, c, x2]))
	await page.keyboard.press("Escape")

	// A virtual keyboard (Android): key 229 / "Unidentified", then text.
	let cdp = await page.createCDPSession()
	let soft = async ch => {
		await cdp.send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229})
		await cdp.send("Input.insertText", {text: ch})
		await cdp.send("Input.dispatchKeyEvent", {type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229})
		await frames()
	}
	let before = await vim()
	await soft("x")
	v = await vim()
	check("vim + virtual keyboard: a normal-mode letter is a command, not text", v.line.length == before.line.length - 1 && !v.line.includes("xx"),
		JSON.stringify([before.line, v.line]))
	check("vim + virtual keyboard: focus stays in the editor", await page.evaluate(() => document.activeElement == view.contentDOM && view.hasFocus))
	// More virtual-keyboard keys after that hang headless Chromium's
	// input pipeline (Input.insertText never returns) in CodeMirror's
	// own DOM editor too (cm.html?vim=1): Vim's forceEndComposition
	// detaching the scroller while CDP holds a key down.

	// A fling doesn't need Vim: the block cursor is part of the scene
	// layers and moves with the pass offset.
	await page.evaluate(() => { view.stats.length = 0; view.recordStats = true; view.fling(0, 3000) })
	await sleep(400)
	let st = await page.evaluate(() => { view.recordStats = false; return view.stats })
	check("vim: flings run without measuring the cursor", st.length > 5)
}

await page.close()
await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
