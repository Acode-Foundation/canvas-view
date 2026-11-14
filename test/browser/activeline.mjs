// Browser test for the active line frame (`activeLineBorder` in the
// canvas theme, like a theme's `box-shadow: 0 0 0 2px inset` on
// `.cm-activeLine`) and for `setState` dropping the old state's theme
// classes from the editor element. Checks drawn pixels.
//
//   node test/browser/activeline.mjs [--backend=webgl2|webgpu]

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
let errors = []
page.on("pageerror", e => errors.push(e.message))
page.on("console", m => { if (m.type() == "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
await page.setViewport({width: 900, height: 600, deviceScaleFactor: 2})
await page.goto(`${server.url}/index.html?kind=js&lines=400&backend=${backend}&bare=1&ext=basic&blink=0&sticky=0`)
await page.waitForFunction("window.ready === true")
await sleep(300)

const frames = (n = 3) => page.evaluate(n => new Promise(r => {
	let step = () => --n ? requestAnimationFrame(step) : r()
	requestAnimationFrame(step)
}), n)
/// Average color of a screen rectangle (CSS px), as [r, g, b].
const color = async (x, y, w = 4, h = 1) => {
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
		let d = cx.getImageData(0, 0, c.width, c.height).data, s = [0, 0, 0]
		for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]
		return s.map(v => Math.round(v / (d.length / 4)))
	}, png)
}
const near = (a, b, tol = 40) => b.every((v, i) => Math.abs(a[i] - v) <= tol)
const BG = [17, 17, 19], FRAME = [255, 0, 0]

// An outlined active line: no fill, a 2px frame.
await page.evaluate(() => {
	view.setTheme({dark: true, background: "#111113", foreground: "#bbbbbb", activeLine: "transparent",
		activeLineBorder: "#ff0000", activeLineBorderWidth: 2})
	view.focus()
	view.dispatch({selection: {anchor: view.state.doc.line(3).from}})
})
await frames()
const geo = () => page.evaluate(() => {
	let r = view.scrollDOM.getBoundingClientRect(), c = view.coordsAtPos(view.state.doc.line(3).from)
	return {top: c.top, bottom: c.top + view.lineHeight, gutter: r.left + view.gutterWidth, right: r.right}
})
let g = await geo(), x = g.right - 60, mid = (g.top + g.bottom) / 2
let px = async (x, y, w, h) => color(x, y, w, h)
let top = await px(x, g.top + 0.25, 8, 0.5), bottom = await px(x, g.bottom - 0.75, 8, 0.5)
let inside = await px(x, mid, 8, 1), left = await px(g.gutter + 0.25, mid, 0.5, 2)
let other = await px(x, g.top + 2 * (g.bottom - g.top) + 0.25, 8, 0.5)
check("frame's top edge", near(top, FRAME), JSON.stringify(top))
check("frame's bottom edge", near(bottom, FRAME), JSON.stringify(bottom))
check("frame's inside is the background (no fill)", near(inside, BG, 8), JSON.stringify(inside))
check("frame's left edge at the text area's edge", near(left, FRAME), JSON.stringify(left))
check("other lines have no frame", near(other, BG, 8), JSON.stringify(other))

// The frame follows the cursor's line.
await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(5).from}}))
await frames()
let lh = g.bottom - g.top
let moved = await px(x, g.top + 2 * lh + 0.25, 8, 0.5), old = await px(x, g.top + 0.25, 8, 0.5)
check("frame moves with the cursor", near(moved, FRAME) && near(old, BG, 8), JSON.stringify({moved, old}))

// Without a frame, nothing extra is drawn.
await page.evaluate(() => view.setTheme({dark: true, background: "#111113", foreground: "#bbbbbb", activeLine: "transparent"}))
await frames()
let none = await px(x, g.top + 2 * lh + 0.25, 8, 0.5)
check("no frame without activeLineBorder", near(none, BG, 8), JSON.stringify(none))

// setState: the new state's theme classes replace the old state's on
// the editor element (they used to stay, and their CSS kept applying).
let classes = await page.evaluate(() => {
	let {EditorView, EditorState, StateEffect} = cmApi
	view.dispatch({effects: StateEffect.appendConfig.of(EditorView.theme({".cm-tooltip": {color: "red"}}))})
	let withTheme = view.dom.className
	view.setState(EditorState.create({doc: view.state.doc}))
	return {withTheme, after: view.dom.className}
})
let added = classes.withTheme.split(" ").filter(c => !classes.after.split(" ").includes(c))
check("setState removes the old state's theme class", added.length > 0, JSON.stringify(classes))

check("no errors", errors.length == 0, errors.join("; "))
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
await browser.close()
server.close()
process.exit(failures ? 1 : 0)
