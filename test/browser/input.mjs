// Browser tests for text input with real key events, IME composition
// and clipboard events, running stock CodeMirror keymaps, history and
// closeBrackets against the canvas view. Run after `bun run demo:build`:
//
//   node test/browser/input.mjs [--input=editcontext|textarea] [--backend=webgl2|webgpu]

import {launch, parseArgs, phonePage, serveDemo, sleep} from "../../bench/harness.mjs"

const args = parseArgs()
const input = args.input ?? "editcontext"
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
await page.goto(`${server.url}/index.html?kind=js&lines=300&backend=${backend}&input=${input}&bare=1`)
await page.waitForFunction("window.ready === true")
await sleep(200)
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control")

// Put the cursor at the end of a fresh empty line and focus with a tap.
async function freshLine(text = "") {
	await page.evaluate(text => {
		let line = view.state.doc.line(3)
		view.dispatch({changes: {from: line.from, insert: text + "\n"}, selection: {anchor: line.from + text.length}})
		view.scrollTop = 0
	}, text)
	await frames()
	let c = await page.evaluate(() => {
		let c = view.coordsAtPos(view.state.selection.main.head)
		return {x: c.left + 1, y: (c.top + c.bottom) / 2}
	})
	await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: c.x, y: c.y, id: 1}]})
	await sleep(20)
	await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
	await frames()
	await page.evaluate(text => {
		let line = view.state.doc.line(3)
		view.dispatch({selection: {anchor: line.from + text.length}})
	}, text)
}
const line3 = () => page.evaluate(() => view.state.doc.line(3).text)
const lineText = n => page.evaluate(n => view.state.doc.line(n).text, n)
const head = () => page.evaluate(() => {
	let h = view.state.selection.main.head, l = view.state.doc.lineAt(h)
	return {line: l.number, col: h - l.from}
})

check(`input kind is ${input}`, await page.evaluate(() => view.input.kind) == input)

await freshLine()
check("tap focuses the input element", await page.evaluate(() => view.hasFocus))

await page.keyboard.type("let x = 1")
check("typing inserts text", await line3() == "let x = 1", JSON.stringify(await line3()))

await freshLine("call")
await page.keyboard.type("(")
check("closeBrackets adds the closing bracket", await line3() == "call()", JSON.stringify(await line3()))
await page.keyboard.type("a)")
check("typing the closing bracket steps over it", await line3() == "call(a)", JSON.stringify(await line3()))

await freshLine("fn")
await page.keyboard.type("{")
await page.keyboard.press("Enter")
check("Enter between brackets indents", await lineText(4) == "  " && await lineText(5) == "}",
	JSON.stringify([await line3(), await lineText(4), await lineText(5)]))

await freshLine("abcdef")
await page.keyboard.press("Backspace")
await page.keyboard.press("Backspace")
check("Backspace deletes backward", await line3() == "abcd", JSON.stringify(await line3()))
await page.keyboard.press("ArrowLeft")
await page.keyboard.press("ArrowLeft")
check("ArrowLeft moves the cursor", (await head()).col == 2, JSON.stringify(await head()))
await page.keyboard.press("Delete")
check("Delete deletes forward", await line3() == "abd", JSON.stringify(await line3()))
await page.keyboard.press("End")
check("End goes to line end", (await head()).col == 3, JSON.stringify(await head()))
await page.keyboard.press("Home")
check("Home goes to line start", (await head()).col == 0, JSON.stringify(await head()))
await page.keyboard.press("ArrowDown")
check("ArrowDown moves to the next line", (await head()).line == 4, JSON.stringify(await head()))
await page.keyboard.press("ArrowUp")
check("ArrowUp moves back", (await head()).line == 3, JSON.stringify(await head()))

await freshLine("undo")
await page.keyboard.type(" me")
await sleep(600)
await page.keyboard.down(mod)
await page.keyboard.press("z")
await page.keyboard.up(mod)
check("Mod-z undoes typing", await line3() == "undo", JSON.stringify(await line3()))
await page.keyboard.down(mod)
await page.keyboard.down("Shift")
await page.keyboard.press("z")
await page.keyboard.up("Shift")
await page.keyboard.up(mod)
check("Mod-Shift-z redoes", await line3() == "undo me", JSON.stringify(await line3()))

await freshLine("sel")
await page.keyboard.down(mod)
await page.keyboard.press("a")
await page.keyboard.up(mod)
let all = await page.evaluate(() => [view.state.selection.main.from, view.state.selection.main.to, view.state.doc.length])
check("Mod-a selects all", all[0] == 0 && all[1] == all[2], JSON.stringify(all))

// IME composition (e.g. a Japanese keyboard): composing text shows up
// live, gets an underline, and commits.
await freshLine("ime ")
await cdp.send("Input.imeSetComposition", {text: "に", selectionStart: 1, selectionEnd: 1})
await frames()
let mid = await page.evaluate(() => ({text: view.state.doc.line(3).text, composing: view.composing, underline: view.overRects.count}))
check("composition text is inserted live", mid.text == "ime に", JSON.stringify(mid))
await cdp.send("Input.imeSetComposition", {text: "にほ", selectionStart: 2, selectionEnd: 2})
await frames()
check("composition updates in place", await line3() == "ime にほ", JSON.stringify(await line3()))
await cdp.send("Input.insertText", {text: "日本"})
await frames()
check("composition commits", await line3() == "ime 日本", JSON.stringify(await line3()))
let after = await page.evaluate(() => ({composing: view.composing, underline: view.overRects.count}))
check("composition state ends", !after.composing, JSON.stringify(after))

// Several cursors: a composition, and a deletion a virtual keyboard
// sends without key events, apply at every cursor.
await freshLine("aa")
await page.evaluate(() => {
	let l3 = view.state.doc.line(3)
	view.dispatch({changes: {from: l3.to + 1, insert: "bb\n"}})
	let ES = view.state.selection.constructor
	view.dispatch({selection: ES.create([ES.cursor(view.state.doc.line(3).to), ES.cursor(view.state.doc.line(4).to)], 0)})
})
await frames()
await cdp.send("Input.imeSetComposition", {text: "に", selectionStart: 1, selectionEnd: 1})
await frames()
await cdp.send("Input.imeSetComposition", {text: "にほ", selectionStart: 2, selectionEnd: 2})
await frames()
check("composition shows at every cursor", await line3() == "aaにほ" && await lineText(4) == "bbにほ",
	JSON.stringify([await line3(), await lineText(4)]))
await cdp.send("Input.insertText", {text: "日本"})
await frames()
check("composition commits at every cursor", await line3() == "aa日本" && await lineText(4) == "bb日本",
	JSON.stringify([await line3(), await lineText(4)]))
await page.evaluate(input => {
	if (input == "editcontext") {
		let ctx = view.input.context, off = view.state.selection.main.head - view.input.from
		ctx.updateText(off - 1, off, "")
		ctx.updateSelection(off - 1, off - 1)
		ctx.dispatchEvent(new TextUpdateEvent("textupdate", {updateRangeStart: off - 1, updateRangeEnd: off, text: "", selectionStart: off - 1, selectionEnd: off - 1}))
	} else {
		let ta = view.contentDOM, i = ta.selectionStart
		ta.value = ta.value.slice(0, i - 1) + ta.value.slice(i)
		ta.setSelectionRange(i - 1, i - 1)
		ta.dispatchEvent(new InputEvent("input", {inputType: "deleteContentBackward", bubbles: true}))
	}
}, input)
await frames()
check("a keyless deletion applies at every cursor", await line3() == "aa日" && await lineText(4) == "bb日",
	JSON.stringify([await line3(), await lineText(4)]))
await page.keyboard.press("Escape")

// Clipboard events.
await freshLine("paste:")
await page.evaluate(() => {
	let dt = new DataTransfer()
	dt.setData("text/plain", " pasted\r\ntext")
	view.contentDOM.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}))
})
check("paste inserts (normalizing line breaks)", await line3() == "paste: pasted" && await lineText(4) == "text",
	JSON.stringify([await line3(), await lineText(4)]))
let copied = await page.evaluate(() => {
	let line = view.state.doc.line(3)
	view.dispatch({selection: {anchor: line.from, head: line.from + 5}})
	let dt = new DataTransfer()
	view.contentDOM.dispatchEvent(new ClipboardEvent("copy", {clipboardData: dt, bubbles: true, cancelable: true}))
	return dt.getData("text/plain")
})
check("copy puts the selection on the clipboard", copied == "paste", JSON.stringify(copied))
let cut = await page.evaluate(() => {
	let dt = new DataTransfer()
	view.contentDOM.dispatchEvent(new ClipboardEvent("cut", {clipboardData: dt, bubbles: true, cancelable: true}))
	return [dt.getData("text/plain"), view.state.doc.line(3).text]
})
check("cut copies and deletes", cut[0] == "paste" && cut[1] == ": pasted", JSON.stringify(cut))

// Clipboard filters (EditorView.clipboardInputFilter / clipboardOutputFilter).
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
await freshLine("filters:")
let filtered = await page.evaluate(() => {
	let event = (type, text) => {
		let dt = new DataTransfer()
		if (text != null) dt.setData("text/plain", text)
		view.contentDOM.dispatchEvent(new ClipboardEvent(type, {clipboardData: dt, bubbles: true, cancelable: true}))
		return dt.getData("text/plain")
	}
	event("paste", " ab\r\ncd")
	let pasted = [view.state.doc.line(3).text, view.state.doc.line(4).text]
	let line = view.state.doc.line(3)
	view.dispatch({selection: {anchor: line.from, head: line.from + 7}})
	let copied = event("copy")
	let cut = event("cut")
	let after = view.state.doc.line(3).text
	window.clipFilters = false
	return {pasted, copied, cut, after}
})
check("paste runs the input filters, in order", filtered.pasted[0] == "filters: AB" && filtered.pasted[1] == "CD-up", JSON.stringify(filtered.pasted))
check("copy runs the output filters", filtered.copied == "<filters>", JSON.stringify(filtered.copied))
check("cut runs the output filters and deletes the selection", filtered.cut == "<filters>" && filtered.after == ": AB", JSON.stringify(filtered))

// The cursor blinks while focused and hides on blur.
let blink = await page.evaluate(async () => {
	let seen = new Set()
	for (let i = 0; i < 16; i++) {
		seen.add(view.cursorOn)
		await new Promise(r => setTimeout(r, 100))
	}
	view.contentDOM.blur()
	await new Promise(r => setTimeout(r, 50))
	return {toggled: seen.size == 2, focusedAfterBlur: view.hasFocus}
})
check("cursor blinks while focused", blink.toggled)
check("blur removes focus", !blink.focusedAfterBlur)

// Atomic ranges (EditorView.atomicRanges): arrows and deletion step
// over them, as in CodeMirror.
await freshLine("let value = placeholder;")
await page.evaluate(() => {
	window.atoms = []
	let {EditorView, StateEffect, Decoration} = cmApi, mark = Decoration.mark({})
	view.dispatch({effects: StateEffect.appendConfig.of(EditorView.atomicRanges.of(() => Decoration.set(window.atoms.map(([a, b]) => mark.range(a, b)), true)))})
	let l = view.state.doc.line(3)
	window.atoms = [[l.from + 12, l.from + 23]]
	view.dispatch({changes: {from: l.to, insert: "\n" + "x".repeat(24)}, selection: {anchor: l.from + 12}})
	view.focus()
})
await frames()
check("a CanvasView counts as an EditorView (instanceof)", await page.evaluate(() => view instanceof cmApi.EditorView && !(({}) instanceof cmApi.EditorView)))
await page.keyboard.press("ArrowRight")
check("atomic: ArrowRight steps over the range", (await head()).col == 23, JSON.stringify(await head()))
await page.keyboard.press("ArrowLeft")
check("atomic: ArrowLeft steps back over it", (await head()).col == 12, JSON.stringify(await head()))
await page.evaluate(() => { let l = view.state.doc.line(4); view.dispatch({selection: {anchor: l.from + 15}}) })
await page.keyboard.press("ArrowUp")
let up = await head()
check("atomic: ArrowUp into the range lands on its edge", up.line == 3 && up.col == 12, JSON.stringify(up))
await page.evaluate(() => { let l = view.state.doc.line(3); view.dispatch({selection: {anchor: l.from + 23}}) })
await page.keyboard.press("Backspace")
check("atomic: Backspace deletes the whole range", await line3() == "let value = ;", JSON.stringify(await line3()))
await page.evaluate(() => { window.atoms = [] })
await page.keyboard.type("v")
check("atomic: typing after the deletion goes to the cursor", await line3() == "let value = v;", JSON.stringify(await line3()))

// Typing latency: key event to GPU submit, at 4x CPU throttling.
await freshLine()
await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4})
for (let ch of "const latency = measure(typing) // check") {
	await page.keyboard.type(ch)
	await sleep(40)
}
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
let lat = await page.evaluate(() => view.stats.filter(s => s.latency >= 0).map(s => s.latency).sort((a, b) => a - b))
let p = q => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]
console.log(`     typing latency at 4x CPU (key event → GPU submit): p50 ${p(0.5)?.toFixed(1)}ms, p95 ${p(0.95)?.toFixed(1)}ms, n=${lat.length}`)
check("typing latency recorded", lat.length > 20, `n=${lat.length}`)

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${input}, ${backend})`)
process.exit(failures ? 1 : 0)
