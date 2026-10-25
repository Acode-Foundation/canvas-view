// Browser tests for on-screen keyboard handling: the editor keeps the
// caret visible when the keyboard shrinks it (`resizes-content`) or
// overlays it (`visualViewport` shrinking, the Android Chrome default
// and iOS behavior), and the covered area becomes scroll room.
//
//   node test/browser/keyboard.mjs [--backend=webgl2|webgpu]

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
await page.goto(`${server.url}/index.html?kind=js&lines=400&backend=${backend}&bare=1`)
await page.waitForFunction("window.ready === true")
await sleep(200)
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
const caret = () => page.evaluate(() => {
	let rect = view.dom.getBoundingClientRect(), c = view.coordsAtPos(view.state.selection.main.head)
	let visibleBottom = window.visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight
	return {top: c.top, bottom: c.bottom, editorBottom: rect.bottom, visibleBottom, inset: view.bottomInset, scrollTop: view.scrollTop}
})

// Put the caret on a line near the bottom of the screen and focus.
async function caretNearBottom() {
	await page.evaluate(() => {
		view.scrollTop = view.lineTop(100)
		let n = view.lineAtHeight(view.scrollTop + view.height - view.lineHeight * 2)
		view.dispatch({selection: {anchor: view.state.doc.line(n).from}})
		view.focus()
	})
	await frames()
}

// 1. resizes-content: the layout viewport (and editor) shrinks.
await caretNearBottom()
let before = await caret()
await page.setViewport({width: 412, height: 480, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true})
await sleep(150)
await frames()
let after = await caret()
check("caret was near the bottom before", before.bottom > 600, JSON.stringify(before))
check("resizes-content: caret stays visible after the editor shrinks", after.bottom <= after.editorBottom, JSON.stringify(after))
await page.setViewport({width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true})
await sleep(150)
await frames()

// A resize reallocates the canvas, which clears it. ResizeObserver
// callbacks run after the frame's animation callbacks, so the view must
// draw in its own callback: checked from an observer that runs after the
// view's, before the browser paints.
for (let height of [320, null]) {
	let drawn = await page.evaluate(height => new Promise(resolve => {
		let canvas = view.scrollDOM.querySelector("canvas"), before = canvas.height
		requestAnimationFrame(() => {
			document.getElementById("editor").style.flex = height ? `0 0 ${height}px` : ""
			let ro = new ResizeObserver(() => {
				ro.disconnect()
				let copy = document.createElement("canvas")
				copy.width = canvas.width
				copy.height = canvas.height
				let cx = copy.getContext("2d")
				cx.drawImage(canvas, 0, 0)
				let data = cx.getImageData(0, 0, copy.width, copy.height).data, lit = 0
				for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 300) lit++
				resolve({resized: canvas.height != before, lit})
			})
			ro.observe(view.scrollDOM)
		})
	}), height)
	let what = height ? "shrinking" : "growing"
	check(`${what} the editor reallocates the canvas`, drawn.resized, JSON.stringify(drawn))
	check(`${what} the editor: text is drawn before the next paint`, drawn.lit > 500, JSON.stringify(drawn))
	await frames()
}

// 2. Overlay: the visual viewport shrinks, the layout doesn't.
await caretNearBottom()
await page.evaluate(() => {
	let fake = new EventTarget()
	Object.assign(fake, {offsetTop: 0, offsetLeft: 0, width: innerWidth, height: innerHeight - 340, scale: 1})
	Object.defineProperty(window, "visualViewport", {value: fake, configurable: true})
	view.onViewportChange()
})
await frames()
after = await caret()
check("overlay: keyboard inset is measured", Math.abs(after.inset - 340) < 2, JSON.stringify(after))
check("overlay: caret moves above the keyboard", after.bottom <= after.visibleBottom, JSON.stringify(after))

// The last line can be scrolled above the keyboard.
let end = await page.evaluate(() => {
	view.scrollTop = 1e9
	let last = view.coordsAtPos(view.state.doc.length)
	return {bottom: last.bottom, visibleBottom: visualViewport.offsetTop + visualViewport.height}
})
check("overlay: the last line can scroll above the keyboard", end.bottom <= end.visibleBottom, JSON.stringify(end))

// Typing at the bottom keeps the caret above the keyboard.
await caretNearBottom()
await page.keyboard.type("x")
await page.keyboard.press("Enter")
await page.keyboard.press("Enter")
await frames()
after = await caret()
check("overlay: typing keeps the caret above the keyboard", after.bottom <= after.visibleBottom, JSON.stringify(after))

// Keyboard closes: the inset goes away.
await page.evaluate(() => {
	Object.assign(window.visualViewport, {height: innerHeight})
	view.onViewportChange()
})
after = await caret()
check("keyboard close clears the inset", after.inset == 0, JSON.stringify(after))

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
