// Browser tests for mouse selection and text drag-and-drop with real
// mouse events: clicks, Mod-click cursors, shift-click, word/line
// clicks and drags, CodeMirror's rectangularSelection (Alt-drag) and
// crosshairCursor, native drag-and-drop (move, copy, drop cursor,
// drops from outside) and typing at several cursors.
//
//   node test/browser/mouse.mjs [--backend=webgl2|webgpu]

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
await page.goto(`${server.url}/index.html?kind=js&lines=200&backend=${backend}&bare=1&ext=full`)
await page.waitForFunction("window.ready === true")
await sleep(300)
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
const mac = await page.evaluate(() => /Mac/.test(navigator.platform))
const mod = mac ? "Meta" : "Control"
const copyMod = mac ? "Alt" : "Control"

const LINES = ["alpha beta gamma", "one two three", "four five six", "seven eight nine", "ten"]
async function reset() {
	await page.evaluate(text => {
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: 0}})
		view.scrollTop = 0
		view.scrollLeft = 0
	}, LINES.join("\n") + "\n")
	await frames()
}
/// Document position of `needle` in line `n` (+ `off`).
const posOf = (n, needle, off = 0) => page.evaluate((n, needle, off) => {
	let l = view.state.doc.line(n), i = l.text.indexOf(needle)
	if (i < 0) throw new Error(`no ${needle} in line ${n}`)
	return l.from + i + off
}, n, needle, off)
/// Client point inside the cell right of `pos` (at `dx` of its width).
const at = (pos, dx = 0.5) => page.evaluate((pos, dx) => {
	let c = view.coordsAtPos(pos)
	return {x: c.left + view.cellWidth * dx, y: (c.top + c.bottom) / 2, top: c.top, bottom: c.bottom}
}, pos, dx)
const ranges = () => page.evaluate(() => view.state.selection.ranges.map(r => [r.anchor, r.head]))
const lineText = n => page.evaluate(n => view.state.doc.line(n).text, n)
const text = (from, to) => page.evaluate((from, to) => view.state.sliceDoc(from, to), from, to)
async function click(p, opts = {}) {
	await page.mouse.click(p.x, p.y, opts)
	await frames()
}
async function withKey(key, f) {
	await page.keyboard.down(key)
	try { await f() } finally { await page.keyboard.up(key) }
}
async function dragMouse(a, b, steps = 8) {
	await page.mouse.move(a.x, a.y)
	await page.mouse.down()
	await page.mouse.move(b.x, b.y, {steps})
	await page.mouse.up()
	await frames()
}
/// Whether the theme's cursor color (#528bff) draws a vertical bar near x.
const cursorDrawnNear = async (x, top, bottom) => {
	await frames()
	let clip = {x: Math.max(0, x - 8), y: top + 2, width: 16, height: Math.max(4, bottom - top - 4)}
	let png = await page.screenshot({clip, encoding: "base64"})
	return page.evaluate(async png => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let c = document.createElement("canvas")
		c.width = img.width
		c.height = img.height
		let cx = c.getContext("2d")
		cx.drawImage(img, 0, 0)
		let d = cx.getImageData(0, 0, c.width, c.height).data
		for (let x = 0; x < c.width; x++) {
			let hits = 0
			for (let y = 0; y < c.height; y++) {
				let i = (y * c.width + x) * 4
				if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) hits++
			}
			if (hits > c.height * 0.8) return true
		}
		return false
	}, png)
}

await reset()

// ---- Clicks and multiple cursors ----------------------------------------------

let beta = await posOf(1, "beta"), two = await posOf(2, "two"), five = await posOf(3, "five")
await click(await at(beta, 0.1))
check("click places the cursor", JSON.stringify(await ranges()) == JSON.stringify([[beta, beta]]), JSON.stringify(await ranges()))
check("click focuses the editor", await page.evaluate(() => view.hasFocus))

await withKey(mod, async () => click(await at(two, 0.1)))
let r = await ranges()
check(`${mod}-click adds a cursor`, r.length == 2 && r.some(([a]) => a == beta) && r.some(([a]) => a == two), JSON.stringify(r))
await withKey(mod, async () => click(await at(five, 0.1)))
check(`${mod}-click adds a third cursor`, (await ranges()).length == 3, JSON.stringify(await ranges()))
let drawn = []
for (let pos of [beta, two, five]) {
	let p = await at(pos, 0)
	await page.evaluate(() => { view.cursorOn = true })
	drawn.push(await cursorDrawnNear(p.x, p.top, p.bottom))
}
check("every cursor is drawn", drawn.every(Boolean), JSON.stringify(drawn))

await page.keyboard.type("X")
check("typing inserts at every cursor",
	await lineText(1) == "alpha Xbeta gamma" && await lineText(2) == "one Xtwo three" && await lineText(3) == "four Xfive six",
	JSON.stringify([await lineText(1), await lineText(2), await lineText(3)]))
await page.keyboard.press("Backspace")
check("Backspace deletes at every cursor", await lineText(1) == LINES[0] && await lineText(2) == LINES[1] && await lineText(3) == LINES[2],
	JSON.stringify([await lineText(1), await lineText(2), await lineText(3)]))
await withKey(mod, async () => click(await at(two, 0.1)))
r = await ranges()
check(`${mod}-click on a cursor removes it`, r.length == 2 && !r.some(([a]) => a == two), JSON.stringify(r))
await page.keyboard.press("Escape")
check("Escape returns to one cursor", (await ranges()).length == 1, JSON.stringify(await ranges()))

await click(await at(beta, 0.1))
await withKey("Shift", async () => click(await at(five, 0.1)))
check("shift-click extends the selection", JSON.stringify(await ranges()) == JSON.stringify([[beta, five]]), JSON.stringify(await ranges()))

// ---- Double and triple clicks ---------------------------------------------------

await page.mouse.click((await at(beta + 1)).x, (await at(beta + 1)).y, {clickCount: 1})
await page.mouse.click((await at(beta + 1)).x, (await at(beta + 1)).y, {clickCount: 2})
await frames()
r = await ranges()
check("double click selects a word", await text(Math.min(...r[0]), Math.max(...r[0])) == "beta", JSON.stringify(r))

{
	// (Clicks at one spot within 400ms would count on from the last test.)
	await sleep(450)
	let p = await at(beta + 1), q = await at(await posOf(1, "gamma", 2))
	await page.mouse.move(p.x, p.y)
	await page.mouse.down({clickCount: 1})
	await page.mouse.up({clickCount: 1})
	await page.mouse.down({clickCount: 2})
	await page.mouse.move(q.x, q.y, {steps: 5})
	await page.mouse.up({clickCount: 2})
	await frames()
	r = await ranges()
	check("double click + drag extends by words", await text(Math.min(...r[0]), Math.max(...r[0])) == "beta gamma", JSON.stringify(r))
}

{
	await sleep(450)
	let p = await at(two + 1)
	for (let n = 1; n <= 3; n++) await page.mouse.click(p.x, p.y, {clickCount: n})
	await frames()
	r = await ranges()
	check("triple click selects the line", await text(Math.min(...r[0]), Math.max(...r[0])) == LINES[1] + "\n", JSON.stringify(r))
}

// ---- rectangularSelection and crosshairCursor -------------------------------------

{
	let a = await at(await posOf(1, "pha"), 0.1), b = await at(await posOf(3, " five", 3), 0.1)
	await page.keyboard.down("Alt")
	await dragMouse(a, b)
	await page.keyboard.up("Alt")
	r = await ranges()
	let texts = await Promise.all(r.map(([x, y]) => text(Math.min(x, y), Math.max(x, y))))
	check("Alt-drag makes a rectangular selection", r.length == 3 && texts.join("|") == "pha b|e two|ur fi", JSON.stringify(texts))
	let past = await at(await posOf(5, "ten", 3), 6), start = await at(await posOf(4, "seven", 2))
	await page.keyboard.down("Alt")
	await dragMouse(start, past)
	await page.keyboard.up("Alt")
	r = await ranges()
	check("rectangle past a short line's end gets a cursor there", r.length == 2 && r[1][0] == r[1][1] && r[1][0] == await posOf(5, "ten", 3), JSON.stringify(r))
}

await click(await at(beta, 0.1))
let cursorStyle = () => page.evaluate(() => view.scrollDOM.style.cursor)
await page.keyboard.down("Alt")
await sleep(30)
check("crosshairCursor: Alt shows a crosshair", await cursorStyle() == "crosshair", JSON.stringify(await cursorStyle()))
await page.keyboard.up("Alt")
await sleep(30)
check("crosshairCursor: releasing Alt restores the cursor", await cursorStyle() == "", JSON.stringify(await cursorStyle()))

// ---- Drag and drop -------------------------------------------------------------------

await reset()
await page.evaluate(b => view.dispatch({selection: {anchor: b, head: b + 4}}), beta)
{
	let p = await at(beta + 2), dest = await at(await posOf(3, "four"), 0.1)
	await page.mouse.move(p.x, p.y)
	await page.mouse.down()
	await page.mouse.move(dest.x, dest.y, {steps: 10})
	let mid = await page.evaluate(() => ({drop: view.dropPos, focus: view.hasFocus}))
	check("dragging shows a drop position", mid.drop == await posOf(3, "four"), JSON.stringify(mid))
	let dropLine = await at(await posOf(3, "four"), 0)
	check("the drop cursor is drawn", await cursorDrawnNear(dropLine.x, dropLine.top, dropLine.bottom))
	await page.mouse.up()
	await frames()
	check("dropping moves the text", await lineText(1) == "alpha  gamma" && await lineText(3) == "betafour five six",
		JSON.stringify([await lineText(1), await lineText(3)]))
	r = await ranges()
	check("the dropped text is selected", r.length == 1 && await text(Math.min(...r[0]), Math.max(...r[0])) == "beta", JSON.stringify(r))
	check("the drop cursor is gone", await page.evaluate(() => view.dropPos) == null)
	check("focus stays in the editor after a drag", await page.evaluate(() => view.hasFocus))
	check("the surface isn't draggable after a drag", !(await page.evaluate(() => view.scrollDOM.draggable)))
}

await reset()
await page.evaluate(b => view.dispatch({selection: {anchor: b, head: b + 4}}), beta)
{
	let p = await at(beta + 2), dest = await at(await posOf(2, "one"), 0.1)
	await page.mouse.move(p.x, p.y)
	await page.mouse.down()
	await page.keyboard.down(copyMod)
	await page.mouse.move(dest.x, dest.y, {steps: 10})
	await page.mouse.up()
	await page.keyboard.up(copyMod)
	await frames()
	check(`dragging with ${copyMod} copies`, await lineText(1) == LINES[0] && await lineText(2) == "betaone two three",
		JSON.stringify([await lineText(1), await lineText(2)]))
}

await reset()
await page.evaluate(b => view.dispatch({selection: {anchor: b, head: b + 4}}), beta)
{
	let p = await at(beta + 2, 0.1)
	await page.mouse.click(p.x, p.y)
	await frames()
	r = await ranges()
	check("a click inside the selection (no drag) places the cursor", r.length == 1 && r[0][0] == r[0][1] && r[0][0] == beta + 2, JSON.stringify(r))
	check("focus stays after a click inside the selection", await page.evaluate(async () => {
		await new Promise(r => setTimeout(r, 20))
		return view.hasFocus
	}))
}

await reset()
{
	let eight = await posOf(4, "eight"), dest = await at(eight, 0.1)
	let res = await page.evaluate(dest => {
		let dt = new DataTransfer()
		dt.setData("text/plain", "EXT\r\n")
		let opts = {dataTransfer: dt, clientX: dest.x, clientY: dest.y, bubbles: true, cancelable: true}
		let over = new DragEvent("dragover", opts)
		view.scrollDOM.dispatchEvent(over)
		let shown = view.dropPos
		view.scrollDOM.dispatchEvent(new DragEvent("drop", opts))
		return {accepted: over.defaultPrevented, shown, after: view.dropPos}
	}, dest)
	check("dragover from outside is accepted and shows the drop position", res.accepted && res.shown == eight, JSON.stringify(res))
	check("a drop from outside inserts its text", await lineText(4) == "seven EXT" && await lineText(5) == "eight nine",
		JSON.stringify([await lineText(4), await lineText(5)]))
	check("drop clears the drop position", res.after == null)

	// Clipboard filters: drops run the input filters, drag starts the output ones.
	let filtered = await page.evaluate(dest => {
		let {EditorView, StateEffect} = window.cmApi
		window.clipFilters = true
		// In facet order: uppercase first, then a suffix that tells the order.
		view.dispatch({effects: StateEffect.appendConfig.of([
			EditorView.clipboardInputFilter.of(t => window.clipFilters ? t.toUpperCase() : t),
			EditorView.clipboardInputFilter.of((t, state) => window.clipFilters && state == view.state ? t + (t == t.toUpperCase() ? "-up" : "-low") : t),
			EditorView.clipboardOutputFilter.of(t => window.clipFilters ? `<${t}>` : t)
		])})
		let dt = new DataTransfer()
		dt.setData("text/plain", "ext ")
		view.scrollDOM.dispatchEvent(new DragEvent("drop", {dataTransfer: dt, clientX: dest.x, clientY: dest.y, bubbles: true, cancelable: true}))
		let dropped = view.state.doc.line(5).text
		let from = view.state.doc.line(5).from
		view.dispatch({selection: {anchor: from, head: from + 3}})
		let out = new DataTransfer()
		view.scrollDOM.dispatchEvent(new DragEvent("dragstart", {dataTransfer: out, bubbles: true, cancelable: true}))
		view.scrollDOM.dispatchEvent(new DragEvent("dragend", {bubbles: true}))
		window.clipFilters = false
		return {dropped, dragged: out.getData("text/plain")}
	}, await at(await posOf(5, "eight"), 0.1))
	check("a drop runs the input filters", filtered.dropped == "EXT -upeight nine", JSON.stringify(filtered))
	check("a drag start runs the output filters", filtered.dragged == "<EXT>", JSON.stringify(filtered))
}

// Atomic ranges: clicks and drags don't end inside one.
await reset()
{
	let beta = await posOf(1, "beta")
	await page.evaluate(beta => {
		window.atoms = []
		let {EditorView, StateEffect, Decoration} = cmApi, mark = Decoration.mark({})
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.atomicRanges.of(() => Decoration.set(window.atoms.map(([a, b]) => mark.range(a, b)), true)))})
		window.atoms = [[beta, beta + 4]]
	}, beta)
	await sleep(500)
	await click(await at(beta + 1, 0.1))
	let r = await ranges()
	check("atomic: a click inside a range goes to its nearer edge (start)", r.length == 1 && r[0][0] == beta && r[0][1] == beta, JSON.stringify(r))
	await sleep(500)
	await click(await at(beta + 3, 0.6))
	r = await ranges()
	check("atomic: a click inside a range goes to its nearer edge (end)", r.length == 1 && r[0][0] == beta + 4 && r[0][1] == beta + 4, JSON.stringify(r))
	await sleep(500)
	await dragMouse(await at(0, 0.1), await at(beta + 2, 0.5))
	r = await ranges()
	check("atomic: a drag selection grows over the range it ends in", r.length == 1 && r[0][0] == 0 && r[0][1] == beta + 4, JSON.stringify(r))
	await page.evaluate(() => { window.atoms = [] })
}

await page.close()
await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
