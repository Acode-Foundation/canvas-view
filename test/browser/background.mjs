// Browser test for see-through backgrounds: a theme background with
// alpha below 1 (or "transparent") makes the canvas show what's behind
// the editor (a picture on `.cm-editor::before`, like Acode's Backdrop
// plugin draws), while text, the gutter numbers, sticky lines and the
// block cursor's character are still drawn, and switching back makes it
// opaque again.
//
//   node test/browser/background.mjs [--backend=webgl2|webgpu]

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
await page.goto(`${server.url}/index.html?kind=js&lines=2000&backend=${backend}&bare=1&ext=basic&blink=0&sticky=3`)
await page.waitForFunction("window.ready === true")
await sleep(300)

const frames = (n = 3) => page.evaluate(n => new Promise(r => {
	let step = () => --n ? requestAnimationFrame(step) : r()
	requestAnimationFrame(step)
}), n)
/// Average color of a screen rectangle (CSS px), as [r, g, b].
const color = async (x, y, w = 6, h = 4) => {
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
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const MAGENTA = [255, 0, 255], EDITOR = [10, 20, 30]

// A picture behind the code, the way Backdrop puts one there, and an
// editor background from the CSS (used when the theme's is transparent).
await page.addStyleTag({content: `
	.cm-editor { position: relative; isolation: isolate; background-color: rgb(10, 20, 30); }
	.cm-editor::before { content: ""; position: absolute; inset: 0; z-index: -1; background: #f0f; pointer-events: none; }
`})
let geo = await page.evaluate(() => {
	view.scrollTop = view.maxScrollTop
	let r = view.scrollDOM.getBoundingClientRect()
	return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, gutter: view.gutterWidth, contextRecoveries: view.contextRecoveries}
})
await frames()
// Below the last line (scrolled past the end): nothing but background.
let emptyText = () => color(geo.right - 80, geo.bottom - 30)
let emptyGutter = () => color(geo.left + 2, geo.bottom - 30)
let opaqueBg = await page.evaluate(() => { let c = view.theme.background; return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255] })

{
	let state = await page.evaluate(() => ({transparent: view.backend.transparent, opaque: view.theme.opaque}))
	check("opaque theme: opaque canvas", state.opaque && !state.transparent, JSON.stringify(state))
	let c = await emptyText()
	check("opaque theme: the picture is hidden", near(c, opaqueBg), JSON.stringify({c, opaqueBg}))
}

// ---- Transparent ------------------------------------------------------------
let canvasBefore = await page.evaluate(() => (window.oldCanvas = view.canvas, true))
await page.evaluate(() => view.setTheme({...view.theme.spec, background: "transparent", gutterBackground: "transparent"}))
await frames()
{
	let state = await page.evaluate(() => ({
		transparent: view.backend.transparent, kind: view.backend.kind, replaced: view.canvas != window.oldCanvas,
		inline: view.dom.style.background, recoveries: view.contextRecoveries, lost: view.backend.lost
	}))
	check("transparent theme: see-through canvas", state.transparent && !state.lost, JSON.stringify(state))
	check(backend == "webgpu" ? "WebGPU switches in place" : "WebGL2 gets a new canvas",
		backend == "webgpu" ? !state.replaced : state.replaced, JSON.stringify(state))
	check("not counted as a context recovery", state.recoveries == geo.contextRecoveries, JSON.stringify(state))
	check("the editor element's background is left to the CSS", state.inline == "", state.inline)
	let t = await emptyText(), g = await emptyGutter()
	check("the picture shows behind the text area", near(t, MAGENTA), JSON.stringify(t))
	check("and behind the gutter", near(g, MAGENTA), JSON.stringify(g))
}
// Text is still drawn: scroll to the top, where line 1 has text.
await page.evaluate(() => { view.scrollTop = 0 })
await frames()
{
	let info = await page.evaluate(() => {
		// Line 2: line 1 has the cursor, on the theme's (opaque) active line.
		let r = view.coordsAtPos(view.state.doc.line(2).from)
		let n = view.state.doc.line(2).length
		return {x: r.left, y: r.top, h: r.bottom - r.top, w: Math.min(n, 20) * view.cellWidth}
	})
	let png = await page.screenshot({clip: {x: info.x, y: info.y, width: info.w, height: info.h}, encoding: "base64"})
	let stats = await page.evaluate(async png => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let c = document.createElement("canvas")
		c.width = img.width
		c.height = img.height
		let cx = c.getContext("2d")
		cx.drawImage(img, 0, 0)
		// Magenta has no green (the active line tints it a little); the
		// dark theme's text has plenty.
		let d = cx.getImageData(0, 0, c.width, c.height).data, picture = 0, ink = 0
		for (let i = 0; i < d.length; i += 4) {
			if (d[i] > 200 && d[i + 1] < 40 && d[i + 2] > 200) picture++
			else if (d[i + 1] > 100) ink++
		}
		return {picture, ink}
	}, png)
	check("text is drawn over the picture", stats.picture > 0 && stats.ink > 0, JSON.stringify(stats))
}

// Sticky lines are see-through too: no text is drawn under them.
{
	let found = await page.evaluate(async () => {
		let frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		for (let row = 5; row < 400; row += 3) {
			view.scrollTop = view.rowTop(0) + row * view.lineHeight
			await frame()
			if (view.sticky.lines.length) return {row, lines: view.sticky.lines.length}
		}
		return null
	})
	check("a scroll position with sticky lines", !!found, JSON.stringify(found))
	if (found) {
		let lh = await page.evaluate(() => view.lineHeight)
		let c = await color(geo.right - 80, geo.top + lh / 2 - 2)
		check("sticky lines show the picture", near(c, MAGENTA, 12), JSON.stringify(c))
		// Nothing of the text, cursor or gutter is drawn under them: those
		// passes start below the sticky area, and the last sticky line
		// (which slides under the others when pushed) stays in its slot.
		let clips = await page.evaluate(() => {
			let passes = view.passList, h = view.sticky.height
			let scene = passes.find(p => p.buffer == view.scene.glyphs)
			let gutter = passes.find(p => p.buffer == view.scene.gutter)
			let last = passes.find(p => p.buffer == view.stickyParts[0].glyphs)
			return {h, scene: scene?.clip?.y, gutter: gutter?.clip?.y, last: last?.clip?.y,
				lastTop: (view.sticky.lines.length - 1) * view.lineHeight}
		})
		check("text and gutter are clipped below the sticky lines",
			clips.h > 0 && clips.scene == clips.h && clips.gutter == clips.h && clips.last == clips.lastTop, JSON.stringify(clips))
	}
}

// The block cursor's character is drawn in an opaque color.
{
	let tint = await page.evaluate(async () => {
		view.reconfigure({cursorStyle: "block"})
		view.focus()
		view.dispatch({selection: {anchor: view.state.doc.line(1).from}})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let b = view.cursorGlyphs
		return b.count ? b.u32[4] >>> 0 : null
	})
	check("block cursor character: opaque, the editor color", tint != null && tint >>> 24 == 255 &&
		near([tint & 255, (tint >>> 8) & 255, (tint >>> 16) & 255], EDITOR, 1), String(tint))
	await page.evaluate(() => view.reconfigure({cursorStyle: "line"}))
}

// ---- Half transparent -------------------------------------------------------
await page.evaluate(() => { view.scrollTop = view.maxScrollTop; view.setTheme({...view.theme.spec, background: "rgba(0, 0, 0, 0.5)", gutterBackground: undefined}) })
await frames()
{
	let t = await emptyText()
	// Half black over (magenta over the CSS's editor color, which the
	// inline background replaces with the half-transparent one).
	check("half-transparent background blends with the picture", near(t, [128, 0, 128], 12), JSON.stringify(t))
	let inline = await page.evaluate(() => view.dom.style.background)
	check("a partly transparent background is set on the editor element", /rgba\(0, 0, 0, 0\.5\)/.test(inline), inline)
}

// ---- Opaque again -----------------------------------------------------------
await page.evaluate(() => view.setTheme({...view.theme.spec, background: "#282c34", gutterBackground: "#282c34"}))
await frames()
{
	let state = await page.evaluate(() => ({transparent: view.backend.transparent}))
	check("opaque again: opaque canvas", !state.transparent, JSON.stringify(state))
	let c = await emptyText()
	check("opaque again: the picture is hidden", near(c, [0x28, 0x2c, 0x34]), JSON.stringify(c))
}

check("no page errors", errors.length == 0, errors.join("; "))
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
await browser.close()
server.close()
process.exit(failures ? 1 : 0)
