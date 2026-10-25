// Browser test for sticky scroll: which header lines stick, that they
// are drawn over the text, that pushing the last one up and scrolling
// within a row rebuild and upload nothing, taps and clicks on them,
// keeping the cursor clear of them, wrapping, edits, block widgets,
// and turning it off. Run after `bun run demo:build`:
//
//   node test/browser/sticky.mjs [--backend=webgl2|webgpu] [--browser=path]

import {launch, parseArgs, phonePage, serveDemo, sleep} from "../../bench/harness.mjs"

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

async function open(query) {
	let page = await phonePage(browser)
	let errors = []
	page.on("pageerror", e => errors.push(e.message))
	page.on("console", m => { if (m.type() == "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
	await page.goto(`${server.url}/index.html?backend=${backend}&bare=1&sticky=5&${query}`)
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
	/// Scroll so that row `row` (fractional) is at the top.
	let scrollToRow = async row => {
		await page.evaluate(row => { view.scrollTop = view.rowTop(0) + row * view.lineHeight }, row)
		await frames()
	}
	let sticky = () => page.evaluate(() => ({lines: [...view.sticky.lines], push: view.sticky.push, height: view.sticky.height}))
	/// Luminance-ish sum of a strip of the screen (CSS px).
	let ink = async (x, y, w, h) => {
		let png = await page.screenshot({clip: {x, y, width: w, height: h}, encoding: "base64"})
		return page.evaluate(async png => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data, sum = 0
			for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
			return sum / (d.length / 4)
		}, png)
	}
	return {page, cdp, tap, frames, scrollToRow, sticky, ink, errors}
}

// ---- Which lines stick, and pushing -----------------------------------------------
{
	let t = await open("kind=js&lines=2000&ext=basic")
	let {page} = t
	// Line 8 is `export async function loadResource0(...) {`, 10 `for (...) {`,
	// 11 `try {`, 17 `} catch (error) {`, 20/21/23 close them.
	let at = async line => {
		await page.evaluate(n => { view.scrollTop = view.lineTop(n) }, line)
		await t.frames()
		return t.sticky()
	}
	check("nothing sticks at the top", (await at(1)).lines.length == 0)
	let s = await at(13)
	check("function, loop and try stick", JSON.stringify(s.lines) == "[8,10,11]", JSON.stringify(s))
	check("sticky area is three lines", Math.abs(s.height - 3 * await page.evaluate(() => view.lineHeight)) < 0.5, JSON.stringify(s))
	s = await at(18)
	check("the catch block replaces the try block", JSON.stringify(s.lines) == "[8,10,17]", JSON.stringify(s))
	s = await at(22)
	check("only the function after the loop", JSON.stringify(s.lines) == "[8]", JSON.stringify(s))

	// Scrolling through the end of the try block: pushed up by `} catch {`,
	// moving only the pass offset (no rebuild).
	await page.evaluate(() => {
		window.stickyEmits = 0
		let emit = view.emitSticky
		view.emitSticky = function (...a) { window.stickyEmits++; return emit.apply(this, a) }
	})
	let lh = await page.evaluate(() => view.lineHeight), base = await page.evaluate(() => view.lineTop(15))
	let pushes = []
	for (let dy = 0; dy <= lh; dy += lh / 6) {
		await page.evaluate(y => { view.scrollTop = y }, base + dy)
		await t.frames()
		pushes.push((await t.sticky()).push)
	}
	let emits = await page.evaluate(() => window.stickyEmits)
	check("the last line is pushed up gradually", pushes.some(p => p < -1 && p > -lh + 1) && pushes.every((p, i) => !i || p <= pushes[i - 1] + 0.01 || p == 0),
		JSON.stringify(pushes))
	check("pushing rebuilds at most when the lines change", emits <= 2, String(emits))

	// Scrolling within a row: nothing is rebuilt (so nothing uploaded).
	await page.evaluate(() => { view.scrollTop = view.lineTop(13) })
	await t.frames()
	await page.evaluate(() => { window.stickyEmits = 0 })
	for (let i = 1; i <= 5; i++) {
		await page.evaluate(i => { view.scrollTop = view.lineTop(13) + i * 2 }, i)
		await t.frames()
	}
	check("scrolling within a row rebuilds nothing", await page.evaluate(() => window.stickyEmits) == 0)

	// Drawn: slot 0 looks like line 8 itself scrolled to the top, and
	// covers the line under it.
	let rect = await page.evaluate(() => {
		let r = view.scrollDOM.getBoundingClientRect()
		return {left: r.left, top: r.top, width: r.width - 8}
	})
	let strip = () => t.ink(rect.left, rect.top + 1, rect.width, lh - 2)
	await page.evaluate(() => { view.scrollTop = view.lineTop(13) })
	await t.frames()
	let on = await strip()
	await page.evaluate(() => view.reconfigure({stickyScroll: false}))
	await t.frames()
	let off = await strip()
	check("turning it off clears the area", (await t.sticky()).height == 0)
	await page.evaluate(() => { view.scrollTop = view.lineTop(8) })
	await t.frames()
	let real = await strip()
	check("the sticky line covers the text under it", Math.abs(on - off) > 0.5, `${on} vs ${off}`)
	check("the sticky line is drawn like the line itself", Math.abs(on - real) < 0.5, `${on} vs ${real}`)
	await page.evaluate(() => {
		view.reconfigure({stickyScroll: {maxLines: 5}})
		view.scrollTop = view.lineTop(13)
	})
	await t.frames()
	check("turning it on again", JSON.stringify((await t.sticky()).lines) == "[8,10,11]")
	check("no page errors", t.errors.length == 0, t.errors.join("; "))
	await page.close()
}

// ---- Taps, clicks, keyboard ----------------------------------------------------------
{
	let t = await open("kind=js&lines=2000&ext=basic")
	let {page} = t
	await page.evaluate(() => { view.scrollTop = view.lineTop(14) + 5 })
	await t.frames()
	let {top, lh, cl} = await page.evaluate(() => ({top: view.scrollDOM.getBoundingClientRect().top, lh: view.lineHeight, cl: view.contentLeft}))
	await t.tap(cl + 40, top + lh * 1.5)
	await sleep(50)
	let r = await page.evaluate(() => {
		let head = view.state.selection.main.head, line = view.state.doc.lineAt(head)
		return {line: line.number, top: view.scrollTop, want: view.lineTop(10) - view.lineHeight, sticky: [...view.sticky.lines], focus: view.hasFocus}
	})
	check("tapping a sticky line puts the cursor on it", r.line == 10, JSON.stringify(r))
	check("and scrolls it to where it was drawn", Math.abs(r.top - r.want) < 0.5, JSON.stringify(r))
	check("lines above it stay pinned", JSON.stringify(r.sticky) == "[8]", JSON.stringify(r))

	// A long press on a sticky line doesn't select the text under it.
	await page.evaluate(() => { view.scrollTop = view.lineTop(14) + 5; view.dispatch({selection: {anchor: 0}}) })
	await t.frames()
	await t.cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: cl + 40, y: top + lh * 0.5, id: 1}]})
	await sleep(700)
	await t.cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
	await t.frames()
	r = await page.evaluate(() => ({empty: view.state.selection.main.empty, head: view.state.selection.main.head}))
	check("a long press on a sticky line selects no word under it", r.empty, JSON.stringify(r))

	// Mouse click on the gutter number of slot 0.
	await page.evaluate(() => { view.scrollTop = view.lineTop(14) + 5 })
	await t.frames()
	await page.mouse.click(10, top + lh * 0.5)
	await t.frames()
	r = await page.evaluate(() => ({line: view.state.doc.lineAt(view.state.selection.main.head).number, top: view.scrollTop, want: view.lineTop(8)}))
	check("clicking a sticky line number goes to its line", r.line == 8 && Math.abs(r.top - r.want) < 0.5, JSON.stringify(r))

	// Moving the cursor up keeps it clear of the sticky lines.
	await page.evaluate(() => {
		let pos = view.state.doc.line(16).from + 4
		view.focus()
		view.dispatch({selection: {anchor: pos}})
		view.scrollTop = view.lineTop(16) - 4 * view.lineHeight
	})
	await t.frames()
	let hidden = []
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press("ArrowUp")
		await t.frames()
		let c = await page.evaluate(() => {
			let head = view.state.selection.main.head
			let y = view.rowTop(view.posCoords(head).row) - view.scrollTop
			return {line: view.state.doc.lineAt(head).number, y, sticky: view.sticky.height}
		})
		if (c.y < c.sticky - 0.5) hidden.push(c)
	}
	check("the cursor never goes under the sticky lines", hidden.length == 0, JSON.stringify(hidden))

	// Editing a header line redraws it.
	await page.evaluate(() => { view.scrollTop = view.lineTop(13) })
	await t.frames()
	let before = await page.evaluate(() => view.stickyParts[1].glyphs.count)
	await page.evaluate(() => {
		let line = view.state.doc.line(8)
		view.dispatch({changes: {from: line.from, insert: "/*x*/ "}})
	})
	await t.frames()
	let after = await page.evaluate(() => view.stickyParts[1].glyphs.count)
	check("editing a header line redraws it", after == before + 5, `${before} -> ${after}`)
	check("no page errors", t.errors.length == 0, t.errors.join("; "))
	await page.close()
}

// ---- Wrapping, nesting, folds ----------------------------------------------------------
{
	let t = await open("kind=deep&lines=400&wrap=1&ext=basic")
	let {page} = t
	await page.evaluate(() => { view.scrollTop = view.lineTop(19) })
	await t.frames()
	let s = await t.sticky()
	check("deep nesting is capped at maxLines", s.lines.length == 5, JSON.stringify(s))
	let ys = await page.evaluate(() => {
		let out = [], lh = view.lineHeight
		for (let p of view.stickyParts) {
			let b = p.glyphs
			for (let i = 0; i < b.count; i++) out.push(b.f32[i * 5 + 1])
		}
		return {min: Math.min(...out), max: Math.max(...out), lh, slots: view.sticky.lines.length}
	})
	check("sticky lines take one row each", ys.max < ys.slots * ys.lh, JSON.stringify(ys))
	// A folded scope doesn't stick; the scope around it does.
	await page.evaluate(() => view.toggleFold(3))
	await sleep(50)
	await page.evaluate(() => { view.scrollTop = view.lineTop(3) + view.lineHeight * 0.2 })
	await t.frames()
	s = await t.sticky()
	check("folded scopes don't stick", JSON.stringify(s.lines) == "[1,2]", JSON.stringify(s))
	await page.evaluate(() => view.toggleFold(3))
	await sleep(50)

	// A long wrapped header: only its first row.
	await page.evaluate(() => {
		let line = view.state.doc.line(2)
		view.dispatch({changes: {from: line.to - 1, insert: "/* " + "word ".repeat(40) + "*/ "}})
		view.scrollTop = view.lineTop(19)
	})
	await t.frames()
	ys = await page.evaluate(() => {
		let out = [], lh = view.lineHeight, b = view.stickyParts[1].glyphs, ink = 0
		for (let i = 0; i < b.count; i++) out.push(b.f32[i * 5 + 1])
		for (let n = 1; n <= 4; n++) ink += view.state.doc.line(n).text.replace(/\s/g, "").length
		return {max: Math.max(...out), lh, rows: view.lines.vline(2).rows, glyphs: b.count, ink}
	})
	check("a wrapped header draws its first row only", ys.rows > 1 && ys.max < 4 * ys.lh && ys.glyphs < ys.ink - 40, JSON.stringify(ys))

	check("no page errors", t.errors.length == 0, t.errors.join("; "))
	await page.close()
}

// ---- Block widgets and flinging --------------------------------------------------------
{
	let t = await open("kind=js&lines=20000&ext=full")
	let {page} = t
	await page.evaluate(() => { view.scrollTop = view.lineTop(46) })
	await t.frames()
	await sleep(100)
	await t.frames()
	let clip = await page.evaluate(() => ({clip: view.blocks.dom.style.clipPath, h: view.sticky.height}))
	check("block widgets are clipped under the sticky lines", clip.h > 0 && clip.clip.startsWith(`inset(${Math.round(clip.h)}px `), JSON.stringify(clip))

	await page.evaluate(() => { view.recordStats = true; view.stats.length = 0; view.scrollTop = 0 })
	await t.frames()
	await page.evaluate(() => { view.stats.length = 0; view.fling(0, 6000) })
	await sleep(2500)
	let st = await page.evaluate(() => {
		let s = view.stats.filter(f => f.scrollTop > 0), dyn = s.map(f => f.dynMs).sort((a, b) => a - b)
		return {frames: s.length, dynP95: dyn[Math.floor(dyn.length * 0.95)] ?? 0, dynMax: dyn[dyn.length - 1] ?? 0, top: view.scrollTop}
	})
	check("flinging with sticky lines", st.frames > 30 && st.top > 1000, JSON.stringify(st))
	check("sticky work per frame stays small", st.dynMax < 4, JSON.stringify(st))
	check("no page errors", t.errors.length == 0, t.errors.join("; "))
	await page.close()
}

console.log(`\n${passes} passed, ${failures} failed (${backend})`)
await browser.close()
server.close()
process.exit(failures ? 1 : 0)
