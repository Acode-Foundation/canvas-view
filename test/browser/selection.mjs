// Browser tests for touch selection: taps, double/triple taps, long
// press (+ drag to extend), selection handle and cursor handle drags,
// edge auto-scroll, and the consumer menu hook (the demo's menu).
//
//   node test/browser/selection.mjs [--backend=webgl2|webgpu]

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

const page = await phonePage(browser)
const cdp = await page.createCDPSession()
await page.goto(`${server.url}/index.html?kind=js&lines=2000&backend=${backend}&bare=1`)
await page.waitForFunction("window.ready === true")
await sleep(300)
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x, y, id: 1}]})
async function tap(x, y) {
	await touch("touchStart", x, y)
	await sleep(30)
	await touch("touchEnd")
	await sleep(60)
}
async function drag(points, hold = 0) {
	await touch("touchStart", points[0].x, points[0].y)
	if (hold) await sleep(hold)
	for (let p of points.slice(1)) {
		await sleep(16)
		await touch("touchMove", p.x, p.y)
	}
	await sleep(30)
	await touch("touchEnd")
	await frames()
}
/// Client point inside the character at `pos` (vertically centered).
const at = pos => page.evaluate(pos => {
	view.scrollPosIntoView(pos)
	let c = view.coordsAtPos(pos)
	return {x: c.left + view.cellWidth * 0.5, y: (c.top + c.bottom) / 2}
}, pos)
const posOf = (line, needle, after = false) => page.evaluate((line, needle, after) => {
	let l = view.state.doc.line(line), i = l.text.indexOf(needle)
	if (i < 0) throw new Error(`no ${needle} in line ${line}`)
	return l.from + i + (after ? needle.length : 0)
}, line, needle, after)
const sel = () => page.evaluate(() => {
	let r = view.state.selection.main
	return {from: r.from, to: r.to, head: r.head, text: view.state.sliceDoc(r.from, r.to), mode: view.touchSelection.mode}
})
const menu = () => page.evaluate(() => {
	let m = document.getElementById("menu")
	return {shown: m.style.display == "flex", items: [...m.querySelectorAll("button")].map(b => b.textContent)}
})
const handleRect = kind => page.evaluate(kind => {
	let r = view.touchSelection.handleRect(kind)
	return {x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height}
}, kind)
/// Count handle-colored pixels inside a handle's rect.
const handlePixels = async kind => {
	await frames()
	let r = await handleRect(kind)
	let png = await page.screenshot({clip: {x: r.left, y: r.top, width: Math.max(1, r.w), height: Math.max(1, r.h)}, encoding: "base64"})
	return page.evaluate(async png => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let c = document.createElement("canvas")
		c.width = img.width
		c.height = img.height
		let cx = c.getContext("2d")
		cx.drawImage(img, 0, 0)
		let d = cx.getImageData(0, 0, c.width, c.height).data, n = 0
		for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) n++
		return n / (c.width * c.height)
	}, png)
}

// Tap: caret + cursor handle.
let p = await posOf(9, "cache")
let pt = await at(p)
await tap(pt.x, pt.y)
await frames()
let s = await sel()
check("tap places the caret", s.from == s.to && Math.abs(s.head - p) <= 1, JSON.stringify(s))
check("tap shows the cursor handle", s.mode == "cursor", s.mode)
check("cursor handle is drawn", await handlePixels("cursor") > 0.2)

// Tapping the cursor handle opens the menu for a caret.
let h = await handleRect("cursor")
await tap(h.x, h.y)
let m = await menu()
check("tapping the cursor handle opens the menu", m.shown && m.items.includes("Paste") && !m.items.includes("Copy"), JSON.stringify(m))

// Dragging the cursor handle moves the caret.
let target = await at(await posOf(10, "attempt"))
h = await handleRect("cursor")
await drag([h, {x: h.x + 2, y: h.y + 6}, {x: target.x, y: target.y + (h.y - pt.y)}, {x: target.x, y: target.y + (h.y - pt.y)}])
s = await sel()
let expected = await posOf(10, "attempt")
check("dragging the cursor handle moves the caret", Math.abs(s.head - expected) <= 1, `${s.head} vs ${expected}`)

// Double tap selects a word and shows the menu.
p = await posOf(12, "cached")
pt = await at(p + 2)
await tap(pt.x, pt.y)
await tap(pt.x, pt.y)
await frames()
s = await sel()
check("double tap selects the word", s.text == "cached", JSON.stringify(s))
check("selection handles shown", s.mode == "selection")
check("start and end handles are drawn", await handlePixels("start") > 0.2 && await handlePixels("end") > 0.2)
m = await menu()
check("menu shows for the selection", m.shown && m.items.includes("Copy") && m.items.includes("Cut"), JSON.stringify(m))

// Drag the end handle two words further.
let endTarget = await posOf(12, "get", true)
let e = await handleRect("end")
let tp = await at(endTarget - 1)
await drag([e, {x: e.x + 3, y: e.y}, {x: tp.x + (e.x - (await at(s.to - 1)).x), y: e.y}])
s = await sel()
check("dragging the end handle extends the selection", s.text == "cached = cache.get", JSON.stringify(s.text))
m = await menu()
check("menu is shown again after the drag", m.shown)

// Drag the start handle back over the end: never collapses.
let st = await handleRect("start")
let endR = await handleRect("end")
await drag([st, {x: st.x + 4, y: st.y}, {x: endR.left + 1, y: st.y}])
s = await sel()
check("handle drags never collapse the selection", s.from < s.to, JSON.stringify(s))

// Triple tap selects the line.
pt = await at(await posOf(14, "result"))
await tap(pt.x, pt.y)
await tap(pt.x, pt.y)
await tap(pt.x, pt.y)
s = await sel()
let line14 = await page.evaluate(() => view.state.doc.line(14).text)
check("triple tap selects the line", s.text == line14 + "\n", JSON.stringify(s.text))

// Long press selects a word; dragging extends it.
p = await posOf(19, "console")
pt = await at(p + 3)
let further = await at(await posOf(19, "url", true) - 1)
// A finger lands past the middle of the last character it wants.
further.x += await page.evaluate(() => view.cellWidth * 0.3)
await drag([pt, {x: further.x, y: further.y}], 550)
s = await sel()
check("long press + drag extends from the word", s.text.startsWith("console") && s.text.endsWith("url"), JSON.stringify(s.text))
// (A long press on the selection would pick it up: collapse it first.)
await page.evaluate(p => view.dispatch({selection: {anchor: p}}), p)
await touch("touchStart", pt.x, pt.y)
await sleep(550)
await touch("touchEnd")
s = await sel()
check("long press selects the word", s.text == "console", JSON.stringify(s.text))
m = await menu()
check("menu shows after a long press", m.shown)

// Scrolling hides the menu and it comes back when settled.
await drag([{x: 200, y: 600}, {x: 200, y: 560}, {x: 200, y: 520}, {x: 200, y: 500}])
let during = await menu()
await sleep(1200)
let afterScroll = await menu()
check("menu hidden while scrolling", !during.shown || afterScroll.shown, JSON.stringify(during))
check("menu returns after the scroll settles", afterScroll.shown, JSON.stringify(afterScroll))

// Typing drops the handles and the menu.
await page.keyboard.type("x")
s = await sel()
m = await menu()
check("typing hides handles and menu", s.mode == "none" && !m.shown, JSON.stringify({mode: s.mode, m}))

// Edge auto-scroll while dragging a handle.
await page.evaluate(() => { view.scrollTop = 0 })
await frames()
pt = await at(await posOf(5, "Resolves"))
await tap(pt.x, pt.y)
await tap(pt.x, pt.y)
e = await handleRect("end")
let top0 = await page.evaluate(() => view.scrollTop)
await touch("touchStart", e.x, e.y)
for (let y = e.y; y < 850; y += 40) {
	await sleep(16)
	await touch("touchMove", e.x, Math.min(855, y))
}
await sleep(700)
let mid = await page.evaluate(() => ({top: view.scrollTop, to: view.state.selection.main.to}))
await touch("touchEnd")
check("dragging a handle to the edge auto-scrolls", mid.top > top0 + 50, JSON.stringify({top0, mid}))
let lineOfTo = await page.evaluate(to => view.state.doc.lineAt(to).number, mid.to)
check("selection follows the auto-scroll", lineOfTo > 30, `line ${lineOfTo}`)

// Mouse: double click selects a word, triple click a line.
await page.evaluate(() => { view.scrollTop = 0 })
await frames()
pt = await at(await posOf(9, "Cache0"))
await page.mouse.click(pt.x, pt.y, {clickCount: 1})
await page.mouse.click(pt.x, pt.y, {clickCount: 2})
s = await sel()
check("mouse double click selects a word", s.text == "Cache0", JSON.stringify(s.text))
await page.mouse.click(pt.x, pt.y, {clickCount: 3})
s = await sel()
let line9 = await page.evaluate(() => view.state.doc.line(9).text)
check("mouse triple click selects the line", s.text == line9 + "\n", JSON.stringify(s.text))

// Emoji and symbols: double tap, long press and double click select
// the group under the point (emoji apart from the brackets around them).
await page.evaluate(() => {
	view.dispatch({changes: {from: 0, insert: "let ok = a === b ? log(😀🎉) : hi👍🏽x\n"}})
	view.scrollTop = 0
})
await frames()
/// Client point inside the character at `pos`, `f` of the way across it.
const inChar = (pos, f = 0.5) => page.evaluate((pos, f) => {
	view.scrollPosIntoView(pos)
	let a = view.coordsAtPos(pos), b = view.coordsAtPos(pos + [...view.state.sliceDoc(pos, pos + 8)][0].length)
	return {x: a.left + (b.left - a.left) * f, y: (a.top + a.bottom) / 2}
}, pos, f)
async function doubleTap(pt) {
	await sleep(450)
	await tap(pt.x, pt.y)
	await tap(pt.x, pt.y)
	await frames()
	return (await sel()).text
}
let t = await doubleTap(await inChar(await posOf(1, "😀")))
check("double tap selects an emoji run", t == "😀🎉", JSON.stringify(t))
t = await doubleTap(await inChar(await posOf(1, "🎉"), 0.85))
check("double tap on an emoji's right half selects it", t == "😀🎉", JSON.stringify(t))
t = await doubleTap(await inChar(await posOf(1, "==="), 0.85))
check("double tap selects an operator", t == "===", JSON.stringify(t))
t = await doubleTap(await inChar(await posOf(1, "(")))
check("double tap selects a bracket alone", t == "(", JSON.stringify(t))
t = await doubleTap(await inChar(await posOf(1, "👍🏽"), 0.2))
check("double tap selects an emoji with a skin tone between words", t == "👍🏽", JSON.stringify(t))
await sleep(450)
pt = await inChar(await posOf(1, "🎉"))
await touch("touchStart", pt.x, pt.y)
await sleep(550)
await touch("touchEnd")
s = await sel()
check("long press selects an emoji run", s.text == "😀🎉", JSON.stringify(s.text))
await sleep(450)
pt = await inChar(await posOf(1, "?"))
await page.mouse.click(pt.x, pt.y, {clickCount: 1})
await page.mouse.click(pt.x, pt.y, {clickCount: 2})
s = await sel()
check("mouse double click selects a symbol", s.text == "?", JSON.stringify(s.text))
await sleep(450)
pt = await inChar(await posOf(1, "😀"), 0.3)
await page.mouse.click(pt.x, pt.y, {clickCount: 1})
await page.mouse.click(pt.x, pt.y, {clickCount: 2})
s = await sel()
check("mouse double click selects an emoji run", s.text == "😀🎉", JSON.stringify(s.text))

// Multiple cursors by touch: a tap with Ctrl (Cmd on macOS; a hardware
// keyboard) adds a cursor, and so does a consumer's own modifier
// through EditorView.clickAddsSelectionRange (Acode's quick tools Ctrl).
{
	let tapMod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 4 : 2)
	let modTap = async (x, y) => {
		await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y, id: 1}], modifiers: tapMod})
		await sleep(30)
		await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: [], modifiers: tapMod})
		await sleep(60)
	}
	await page.evaluate(() => {
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: "alpha beta\ngamma delta\nepsilon (zeta)\nfour\nfive five five five zeta\n"}, selection: {anchor: 0}})
		view.scrollTop = 0
	})
	await sleep(450)
	// (b is away from a's cursor handle, which would take the tap.)
	let a = await posOf(1, "beta"), b = await posOf(5, "zeta")
	pt = await inChar(a, 0.1)
	await tap(pt.x, pt.y)
	await sleep(450)
	pt = await inChar(b, 0.1)
	await modTap(pt.x, pt.y)
	let ranges = await page.evaluate(() => view.state.selection.ranges.map(r => r.head))
	check("Ctrl-tap adds a cursor", ranges.length == 2 && ranges.includes(a) && ranges.includes(b), JSON.stringify(ranges))
	check("Ctrl-tap shows no handles", (await sel()).mode == "none")
	await sleep(450)
	await modTap(pt.x, pt.y)
	ranges = await page.evaluate(() => view.state.selection.ranges.map(r => r.head))
	check("Ctrl-tap on a cursor removes it", ranges.length == 1 && ranges[0] == a, JSON.stringify(ranges))

	await page.evaluate(() => {
		let {EditorView, StateEffect} = window.cmApi
		window.quickCtrl = false
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.clickAddsSelectionRange.of(e => e.ctrlKey || e.metaKey || window.quickCtrl))})
	})
	await sleep(450)
	await page.evaluate(() => { window.quickCtrl = true })
	await tap(pt.x, pt.y)
	await page.evaluate(() => { window.quickCtrl = false })
	ranges = await page.evaluate(() => view.state.selection.ranges.map(r => r.head))
	check("a consumer's clickAddsSelectionRange adds cursors on tap", ranges.length == 2 && ranges.includes(b), JSON.stringify(ranges))
	await sleep(450)
	pt = await inChar(await posOf(2, "gamma"), 0.1)
	await tap(pt.x, pt.y)
	ranges = await page.evaluate(() => view.state.selection.ranges.length)
	check("a plain tap goes back to one cursor", ranges == 1, JSON.stringify(ranges))
}

// Long press on selected text picks it up; dragging moves it.
{
	let reset = () => page.evaluate(() => {
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: "alpha beta gamma\none two three\nfour five six\n"}})
		let from = view.state.doc.toString().indexOf("beta")
		view.dispatch({selection: {anchor: from, head: from + 4}})
		view.scrollTop = 0
	})
	await reset()
	await sleep(450)
	let beta = await posOf(1, "beta"), four = await posOf(3, "four")
	let p = await inChar(beta + 1), q = await inChar(four, 0.1)
	await touch("touchStart", p.x, p.y)
	await sleep(550)
	let picked = await page.evaluate(() => ({drop: view.dropPos, mode: view.touchSelection.mode, text: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)}))
	check("long press on the selection keeps it and picks it up", picked.text == "beta" && picked.drop != null && picked.mode == "none", JSON.stringify(picked))
	for (let i = 1; i <= 8; i++) {
		await sleep(16)
		await touch("touchMove", p.x + (q.x - p.x) * i / 8, p.y + (q.y - p.y) * i / 8)
	}
	await frames()
	check("dragging moves the drop cursor", await page.evaluate(() => view.dropPos) == four, JSON.stringify(await page.evaluate(() => view.dropPos)))
	await touch("touchEnd")
	await frames()
	let lines = await page.evaluate(() => [1, 2, 3].map(n => view.state.doc.line(n).text))
	check("releasing moves the text", lines[0] == "alpha  gamma" && lines[2] == "betafour five six", JSON.stringify(lines))
	s = await sel()
	check("the moved text stays selected with handles", s.text == "beta" && s.mode == "selection", JSON.stringify(s))
	check("the menu shows after the drop", (await menu()).shown)
	check("the drop cursor is gone", await page.evaluate(() => view.dropPos) == null)

	await reset()
	await sleep(450)
	await touch("touchStart", p.x, p.y)
	await sleep(550)
	await touch("touchEnd")
	await frames()
	s = await sel()
	check("a long press on the selection without moving keeps it", s.text == "beta" && s.mode == "selection" && (await menu()).shown, JSON.stringify(s))
	check("the document is unchanged", await page.evaluate(() => view.state.doc.line(1).text) == "alpha beta gamma")

	// The moved text goes through the clipboard filters, like a mouse
	// drag within CodeMirror (output at the start, input at the drop).
	await reset()
	await page.evaluate(() => {
		let {EditorView, StateEffect} = window.cmApi
		window.clipFilters = true
		// In facet order: uppercase first, then a suffix that tells the order.
		view.dispatch({effects: StateEffect.appendConfig.of([
			EditorView.clipboardInputFilter.of(t => window.clipFilters ? t.toUpperCase() : t),
			EditorView.clipboardInputFilter.of((t, state) => window.clipFilters && state == view.state ? t + (t == t.toUpperCase() ? "-up" : "-low") : t),
			EditorView.clipboardOutputFilter.of(t => window.clipFilters ? `<${t}>` : t)
		])})
	})
	await sleep(450)
	await touch("touchStart", p.x, p.y)
	await sleep(550)
	for (let i = 1; i <= 8; i++) {
		await sleep(16)
		await touch("touchMove", p.x + (q.x - p.x) * i / 8, p.y + (q.y - p.y) * i / 8)
	}
	await touch("touchEnd")
	await frames()
	lines = await page.evaluate(() => { window.clipFilters = false; return [1, 2, 3].map(n => view.state.doc.line(n).text) })
	check("a touch move runs the clipboard filters", lines[0] == "alpha  gamma" && lines[2] == "<BETA>-upfour five six", JSON.stringify(lines))
}

// Atomic ranges: a tap inside one puts the cursor at its nearer edge.
{
	let p = await posOf(1, "gamma")
	await page.evaluate(p => {
		window.atoms = []
		let {EditorView, StateEffect, Decoration} = cmApi, mark = Decoration.mark({})
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.atomicRanges.of(() => Decoration.set(window.atoms.map(([a, b]) => mark.range(a, b)), true)))})
		window.atoms = [[p, p + 5]]
	}, p)
	await sleep(450)
	await tap(...Object.values(await at(p + 1)))
	let s = await sel()
	check("atomic: a tap near a range's start lands on its start", s.from == p && s.to == p, JSON.stringify({s, p}))
	await sleep(450)
	await tap(...Object.values(await at(p + 3)))
	s = await sel()
	check("atomic: a tap near a range's end lands on its end", s.from == p + 5 && s.to == p + 5, JSON.stringify({s, p}))
	await page.evaluate(() => { window.atoms = [] })
}

// The last tap's position (double-tap detection) must stay valid when
// the document shrinks or the state is replaced (switching tabs):
// a stale one threw "Invalid position" on every later tap.
{
	let errors = []
	page.on("pageerror", e => errors.push(e.message))
	let long = Array.from({length: 300}, (_, i) => `line ${i} of a longer document`).join("\n")
	let tapEnd = async () => {
		await sleep(450)
		await tap(...Object.values(await at(await page.evaluate(() => view.state.doc.length - 1))))
	}
	let tapAt = async pos => {
		await sleep(450)
		await tap(...Object.values(await at(pos)))
		return sel()
	}
	await page.evaluate(long => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: long}}), long)
	await tapEnd()
	await page.evaluate(() => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: "x\ny\n"}}))
	let s = await tapAt(0)
	check("a tap after the document shrank places the caret", s.head <= 1 && s.from == s.to, JSON.stringify(s))

	await page.evaluate(long => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: long}}), long)
	await tapEnd()
	await page.evaluate(() => view.setState(cmApi.EditorState.create({doc: "short\ndoc\n"})))
	await frames()
	// Not at 0, where the new state's cursor already is.
	s = await tapAt(7)
	check("a tap after setState with a shorter document places the caret", (s.head == 7 || s.head == 8) && s.from == s.to, JSON.stringify(s))
	check("no errors from taps after the document changed", errors.length == 0, errors.join("; "))
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
