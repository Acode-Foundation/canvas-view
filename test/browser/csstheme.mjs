// Browser test for themes resolved from CodeMirror's style modules: a
// view without a canvas theme draws with its state's `EditorView.theme`
// (background, gutter, active line frame, highlight colors, custom
// properties), follows reconfiguration, and reads no token styles from
// the DOM. Checks drawn pixels.
//
//   node test/browser/csstheme.mjs [--backend=webgl2|webgpu]

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
/// The pixels of a screen rectangle (CSS px): their average color and
/// how many are within 60 of `find` per channel.
const pixels = async (x, y, w, h, find = [0, 0, 0]) => {
	let png = await page.screenshot({clip: {x, y, width: w, height: h}, encoding: "base64"})
	return page.evaluate(async (png, find) => {
		let img = new Image()
		img.src = "data:image/png;base64," + png
		await img.decode()
		let c = document.createElement("canvas")
		c.width = img.width
		c.height = img.height
		let cx = c.getContext("2d")
		cx.drawImage(img, 0, 0)
		let d = cx.getImageData(0, 0, c.width, c.height).data, s = [0, 0, 0], found = 0
		for (let i = 0; i < d.length; i += 4) {
			for (let k = 0; k < 3; k++) s[k] += d[i + k]
			if (find.every((v, k) => Math.abs(d[i + k] - v) <= 60)) found++
		}
		return {avg: s.map(v => Math.round(v / (d.length / 4))), found}
	}, png, find)
}
const near = (a, b, tol = 6) => b.every((v, i) => Math.abs(a[i] - v) <= tol)

// A state with a CodeMirror theme and highlight style, and no canvas
// theme: the view follows the CSS.
await page.evaluate(() => {
	let {EditorView, EditorState, HighlightStyle, syntaxHighlighting, tags, javascript} = cmApi
	window.themed = (rules, extra = []) => [
		javascript(),
		EditorView.theme(rules, {dark: true}),
		syntaxHighlighting(HighlightStyle.define([{tag: tags.keyword, color: "#ff00ff"}, {tag: tags.comment, color: "#00ff00", fontStyle: "italic"}])),
		...extra
	]
	window.rules = {
		"&": {backgroundColor: "#102030", color: "#d0d0d0"},
		".cm-gutters": {backgroundColor: "#302010", color: "#888", borderRight: "none"},
		".cm-activeLine": {boxShadow: "0 0 0 2px inset #ff0000"},
		".cm-content": {caretColor: "#00ffff"},
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {backgroundColor: "#445566"}
	}
	// Count style reads on the hidden token probe (a span).
	window.spanReads = 0
	let original = window.getComputedStyle
	window.getComputedStyle = function(el, ...rest) {
		if (el && el.tagName == "SPAN") window.spanReads++
		return original.call(this, el, ...rest)
	}
	view.setTheme(null)
	view.setState(EditorState.create({doc: "const a = 1\n// note\n\n\nreturn a\n", extensions: themed(rules)}))
	view.focus()
	view.dispatch({selection: {anchor: view.state.doc.line(3).from}})
})
await frames(6)
const geo = () => page.evaluate(() => {
	let r = view.scrollDOM.getBoundingClientRect(), line = n => view.coordsAtPos(view.state.doc.line(n).from)
	return {left: r.left, right: r.right, gutter: r.left + view.gutterWidth, lh: view.lineHeight, l1: line(1), l2: line(2), l3: line(3)}
})
let g = await geo()
let theme = await page.evaluate(() => {
	let t = view.theme, hex = c => "#" + [c & 255, (c >>> 8) & 255, (c >>> 16) & 255].map(v => v.toString(16).padStart(2, "0")).join("")
	return {dark: t.dark, background: hex(t.background), foreground: hex(t.foreground), gutterBackground: hex(t.gutterBackground),
		cursor: hex(t.cursor), selection: hex(t.selection), frame: hex(t.activeLineBorder), frameWidth: t.activeLineBorderWidth}
})
check("theme colors come from the state's theme", JSON.stringify(theme) == JSON.stringify({dark: true, background: "#102030",
	foreground: "#d0d0d0", gutterBackground: "#302010", cursor: "#00ffff", selection: "#445566", frame: "#ff0000", frameWidth: 2}), JSON.stringify(theme))
let bg = await pixels(g.right - 80, g.l1.top + 4, 8, 2)
check("background drawn in the theme's color", near(bg.avg, [16, 32, 48]), JSON.stringify(bg.avg))
let gutter = await pixels(g.left + 1, g.l3.top + 4, 2, 2)
check("gutter drawn in the theme's color", near(gutter.avg, [48, 32, 16]), JSON.stringify(gutter.avg))
let frame = await pixels(g.right - 80, g.l3.top + 0.25, 8, 0.5)
check("active line frame from box-shadow", near(frame.avg, [255, 0, 0], 40), JSON.stringify(frame.avg))
let inside = await pixels(g.right - 80, g.l3.top + g.lh / 2, 8, 1)
check("active line has no fill", near(inside.avg, [16, 32, 48]), JSON.stringify(inside.avg))
let keyword = await pixels(g.gutter, g.l1.top, 60, g.lh, [255, 0, 255])
check("keyword in the highlight style's color", keyword.found > 10, JSON.stringify(keyword))
let comment = await pixels(g.gutter, g.l2.top, 80, g.lh, [0, 255, 0])
check("comment in the highlight style's color", comment.found > 10, JSON.stringify(comment))
check("no token style was read from the DOM", await page.evaluate(() => window.spanReads) == 0, String(await page.evaluate(() => window.spanReads)))

// Reconfiguring the theme: custom properties from the page, a filled
// active line.
await page.evaluate(() => {
	document.documentElement.style.setProperty("--cv-test-bg", "#402000")
	view.dispatch({effects: cmApi.StateEffect.reconfigure.of(themed({
		"&": {backgroundColor: "var(--cv-test-bg)", color: "var(--cv-test-missing, #eeeeee)"},
		".cm-activeLine": {backgroundColor: "#006000"}
	}))})
})
await frames(6)
g = await geo()
bg = await pixels(g.right - 80, g.l1.top + 4, 8, 2)
check("reconfigured: background from a custom property", near(bg.avg, [64, 32, 0]), JSON.stringify(bg.avg))
inside = await pixels(g.right - 80, g.l3.top + g.lh / 2, 8, 1)
check("reconfigured: filled active line", near(inside.avg, [0, 96, 0]), JSON.stringify(inside.avg))
frame = await pixels(g.right - 80, g.l3.top + 0.25, 8, 0.5)
check("reconfigured: no frame", near(frame.avg, [0, 96, 0]), JSON.stringify(frame.avg))
check("reconfigured: var() fallback", await page.evaluate(() => (view.theme.foreground & 0xffffff) == 0xeeeeee))

// Decoration classes: a theme's rule, a base theme's, a built-in
// class a theme restyles.
let marks = await page.evaluate(async () => {
	let {EditorView, Decoration, StateEffect} = cmApi
	let deco = Decoration.set([
		Decoration.mark({class: "cv-test-mark"}).range(0, 5),
		Decoration.mark({class: "cm-searchMatch"}).range(6, 7)
	])
	view.dispatch({effects: StateEffect.appendConfig.of([
		EditorView.decorations.of(deco),
		EditorView.baseTheme({".cv-test-mark": {backgroundColor: "#0000ff"}}),
		EditorView.theme({".cm-searchMatch": {backgroundColor: "#ffff00"}})
	])})
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
	let a = view.coordsAtPos(0), b = view.coordsAtPos(6)
	return {a: {x: a.left, y: a.top}, b: {x: b.left, y: b.top}, cell: view.defaultCharacterWidth}
})
await frames(3)
let mark = await pixels(marks.a.x, marks.a.y + 1, marks.cell * 5, 3, [0, 0, 255])
check("mark class styled by a base theme", mark.found > 20, JSON.stringify(mark))
let match = await pixels(marks.b.x, marks.b.y + 1, marks.cell, 3, [255, 255, 0])
check("built-in class restyled by a theme", match.found > 5, JSON.stringify(match))

// An explicit canvas theme wins; null goes back to the CSS.
await page.evaluate(() => view.setTheme({dark: true, background: "#000080", foreground: "#ffffff"}))
await frames()
bg = await pixels(g.right - 80, g.l1.top + 4, 8, 2)
check("explicit canvas theme wins", near(bg.avg, [0, 0, 128]), JSON.stringify(bg.avg))
await page.evaluate(() => view.setTheme(null))
await frames()
bg = await pixels(g.right - 80, g.l1.top + 4, 8, 2)
check("setTheme(null) follows the CSS again", near(bg.avg, [64, 32, 0]), JSON.stringify(bg.avg))

// A theme function adjusts the CSS-resolved theme, and runs again when
// the state's theme changes.
let fn = await page.evaluate(async () => {
	window.themeCalls = 0
	view.setTheme(css => { window.themeCalls++; return {...css, activeLine: "#800080"} })
	let first = {bg: view.theme.background & 0xffffff, active: view.theme.activeLine & 0xffffff}
	view.dispatch({effects: cmApi.StateEffect.reconfigure.of(themed({"&": {backgroundColor: "#203040", color: "#ffffff"}}))})
	return {first, bg: view.theme.background & 0xffffff, active: view.theme.activeLine & 0xffffff, calls: window.themeCalls}
})
check("theme function: over the CSS's colors", fn.first.bg == 0x002040 && fn.first.active == 0x800080, JSON.stringify(fn))
check("theme function: runs again for a new theme", fn.calls == 2 && fn.bg == 0x403020 && fn.active == 0x800080, JSON.stringify(fn))
await frames()
bg = await pixels(g.right - 80, g.l1.top + 4, 8, 2)
check("theme function: drawn", near(bg.avg, [32, 48, 64]), JSON.stringify(bg.avg))
await page.evaluate(() => view.setTheme(null))

// A state without a theme keeps the default theme.
await page.evaluate(() => view.setState(cmApi.EditorState.create({doc: "plain\n"})))
await frames(4)
// Below the cursor's line (the active line has a fill of its own).
bg = await pixels(g.right - 80, g.l1.top + g.lh * 4, 8, 2)
check("no CodeMirror theme: the default theme", near(bg.avg, [40, 44, 52]), JSON.stringify(bg.avg))

check("no errors", errors.length == 0, errors.join("; "))
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
await browser.close()
server.close()
process.exit(failures ? 1 : 0)
