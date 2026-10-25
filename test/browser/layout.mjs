// Browser test for the layout model and hosted CodeMirror plugins:
// line wrapping (rows, continuation indent, cursor motion, taps, drawn
// cursor), folding (gutter taps, hidden lines, atomic motion,
// placeholder taps, the shared syntax tree), inline widgets, and
// CodeMirror view plugins (search panel, autocomplete, lint, hover,
// viewport-driven decorations). Run after `bun run demo:build`:
//
//   node test/browser/layout.mjs [--backend=webgl2|webgpu] [--browser=path]

import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import {homedir} from "node:os"
import puppeteer from "puppeteer-core"

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	let [k, v] = a.replace(/^--/, "").split("=")
	return [k, v ?? "true"]
}))
const backend = args.backend ?? "webgl2"
const browserPath = args.browser ?? join(homedir(),
	"Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
const root = resolve(import.meta.dirname, "../../demo-dist")

const server = createServer(async (req, res) => {
	let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
	try {
		let body = await readFile(path)
		res.writeHead(200, {"content-type": {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[extname(path)] ?? "application/octet-stream"})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
}).listen(0)
const port = server.address().port
const browser = await puppeteer.launch({executablePath: browserPath, headless: true, args: ["--enable-unsafe-webgpu"]})
const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0, passes = 0
function check(name, ok, detail = "") {
	if (ok) passes++
	else failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
}

async function open(query) {
	let page = await browser.newPage()
	let errors = []
	page.on("pageerror", e => errors.push(e.message))
	page.on("console", m => { if (m.type() == "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
	await page.goto(`http://localhost:${port}/index.html?backend=${backend}&bare=1&${query}`)
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
	let key = async k => {
		await page.keyboard.press(k)
		await frames()
	}
	let sel = () => page.evaluate(() => {
		let m = view.state.selection.main, line = view.state.doc.lineAt(m.head)
		return {head: m.head, line: line.number, col: m.head - line.from, assoc: m.assoc}
	})
	let drawnCursorX = async (x, top, bottom) => {
		await frames()
		let clip = {x: Math.max(0, x - 10), y: top + 2, width: 20, height: Math.max(4, bottom - top - 4)}
		let png = await page.screenshot({clip, encoding: "base64"})
		return page.evaluate(async (png, clipX) => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data
			let cols = []
			for (let x = 0; x < c.width; x++) {
				let hits = 0
				for (let y = 0; y < c.height; y++) {
					let i = (y * c.width + x) * 4
					if (d[i + 2] > 200 && d[i] < 130 && d[i + 1] > 100 && d[i + 1] < 170) hits++
				}
				if (hits > c.height * 0.8) cols.push(x)
			}
			if (!cols.length) return null
			return clipX + (cols[0] + cols[cols.length - 1]) / 2 / (img.width / 20)
		}, png, clip.x)
	}
	return {page, cdp, tap, key, sel, frames, drawnCursorX, errors}
}

// ---- Line wrapping -----------------------------------------------------------
{
	let t = await open("kind=js&lines=20000&ext=basic&wrap=1")
	let {page} = t
	let info = await page.evaluate(() => ({rows: view.lines.totalRows, lines: view.state.doc.lines, wrap: view.lines.wrap}))
	check("wrapping: rows exceed lines", info.rows > info.lines, JSON.stringify(info))
	check("wrapping: no horizontal scroll", await page.evaluate(() => view.maxScrollLeft == 0))

	// Line 9 is "\tconst cache = new Cache0({max: 64, ttl: 60_000})": wraps
	// on a phone, continuation indented like the line.
	let w = await page.evaluate(() => {
		let line = view.state.doc.line(9), vl = view.lines.vline(9)
		let brk = vl.breakPos ? vl.from + vl.breakPos[0] : -1
		let a = view.coordsAtPos(line.from + 1), b = brk >= 0 ? view.coordsAtPos(brk) : null
		return {rows: vl.rows, indent: vl.indent, brk, text: line.text, aLeft: a.left, aTop: a.top, bLeft: b?.left, bTop: b?.top,
			lh: view.lineHeight, cw: view.cellWidth}
	})
	check("wrapping: long line has several rows", w.rows >= 2, JSON.stringify(w))
	check("wrapping: continuation indent = line indent", w.indent > 0, JSON.stringify(w))
	check("wrapping: continuation row is one row down", Math.abs(w.bTop - w.aTop - w.lh) < 0.5, JSON.stringify(w))
	check("wrapping: continuation row starts at the indent", Math.abs(w.bLeft - w.aLeft) < w.cw * 0.5 + 0.5, JSON.stringify(w))

	// Tap on the continuation row places the cursor there.
	await t.tap(w.bLeft + w.cw * 2.3, w.bTop + w.lh / 2)
	let s = await t.sel()
	check("wrapping: tap on continuation row", s.line == 9 && s.head == w.brk + 2, JSON.stringify({s, brk: w.brk}))
	let at = await page.evaluate(() => view.coordsAtPos(view.state.selection.main.head))
	let drawn = await t.drawnCursorX(at.left, at.top, at.bottom)
	check("wrapping: cursor drawn on continuation row", drawn != null && Math.abs(drawn - at.left) < 1.5, `drawn ${drawn} expected ${at.left}`)

	// A tap past the end of a wrapped row puts the cursor at that row's
	// end (assoc -1), not at the start of the next row.
	await sleep(450)
	await t.tap(405, w.aTop + w.lh / 2)
	let endTap = await page.evaluate(() => {
		let m = view.state.selection.main
		return {head: m.head, assoc: m.assoc, row: view.posCoords(m.head, m.assoc || 1).row, first: view.lines.rowOf(9)}
	})
	check("wrapping: tap past a wrapped row's end stays on that row", endTap.head == w.brk && endTap.assoc == -1 && endTap.row == endTap.first,
		JSON.stringify({endTap, brk: w.brk}))

	// Vertical motion goes row by row inside the wrapped line.
	await page.evaluate(brk => { view.dispatch({selection: {anchor: view.state.doc.line(9).from + 3}}); view.focus() }, w.brk)
	await t.key("ArrowDown")
	s = await t.sel()
	check("wrapping: ArrowDown moves to the next row of the same line", s.line == 9 && s.head >= w.brk, JSON.stringify(s))
	await t.key("ArrowUp")
	s = await t.sel()
	check("wrapping: ArrowUp returns to the first row", s.line == 9 && s.head < w.brk, JSON.stringify(s))
	await t.key("End")
	s = await t.sel()
	check("wrapping: End stops at the row end", s.line == 9 && s.head == w.brk, JSON.stringify(s))

	// A selection continuing onto a wrapped row covers its indent too
	// (like VS Code), not just its text.
	let fill = await page.evaluate(async () => {
		let l = view.state.doc.line(9)
		view.dispatch({selection: {anchor: l.from + 2, head: view.state.doc.line(10).from + 1}})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let lh = view.lineHeight, y = (view.lines.rowOf(9) + 1 - view.scene.origin) * lh, buf = view.underRects, rects = []
		for (let i = 0; i < buf.count; i++) {
			let f = buf.f32, at = i * 5
			if (Math.abs(f[at + 1] - y) < 0.5) rects.push([f[at], f[at + 2]])
		}
		return {rects, indent: view.lines.vline(9).indent * view.cellWidth}
	})
	check("wrapping: selection fills the continuation row from the left edge",
		fill.rects.some(([x, w]) => x == 0 && w > fill.indent), JSON.stringify(fill))

	// Indent guides never cross text (VS Code): where the continuation
	// indent is capped at half the width, guides right of it stop at the
	// first row; the ones left of it go through every row.
	let cross = await page.evaluate(async () => {
		let at = view.state.doc.line(10).from, text = " ".repeat(40) + "return getPurchase(product.productId, other, more, args, here)\n"
		view.dispatch({changes: {from: at, insert: text}, selection: {anchor: at + 45}})
		view.scrollTop = view.lines.rowOf(10) * view.lineHeight - 100
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let vl = view.lines.vline(10), lh = view.lineHeight, cw = view.cellWidth
		let top = (view.lines.rowOf(10) - view.scene.origin) * lh
		let guides = [], active = []
		let collect = (buf, out, y0) => {
			for (let i = 0; i < buf.count; i++) {
				let f = buf.f32, o = i * 5
				if (f[o + 2] == 1 && f[o + 3] > 0 && buf.u32[o + 4] >>> 24 && f[o + 1] + f[o + 3] > y0 + 0.5 && f[o + 1] < y0 + vl.rows * lh - 0.5)
					out.push({col: Math.round(f[o] / cw * 10) / 10, rows: Math.round((Math.min(f[o + 1] + f[o + 3], y0 + vl.rows * lh) - Math.max(f[o + 1], y0)) / lh)})
			}
		}
		collect(view.scene.rects, guides, top)
		collect(view.overRects, active, top)
		return {rows: vl.rows, indent: vl.indent, guides, active}
	})
	let bad = cross.guides.filter(g => g.col >= cross.indent ? g.rows != 1 : g.rows != cross.rows)
	check("guides: capped continuation indent blocks the guides right of it",
		cross.rows >= 2 && cross.indent < 40 && cross.guides.some(g => g.col >= cross.indent) && !bad.length, JSON.stringify({bad, cross}))
	check("guides: the active guide stops at the first row too",
		cross.active.length == 1 && cross.active[0].col >= cross.indent && cross.active[0].rows == 1, JSON.stringify(cross))
	await page.evaluate(() => view.dispatch({changes: {from: view.state.doc.line(10).from, to: view.state.doc.line(11).from}}))

	// Editing re-wraps the line.
	let before = await page.evaluate(() => view.lines.vline(9).rows)
	await page.evaluate(() => {
		let l = view.state.doc.line(9)
		view.dispatch({changes: {from: l.to, insert: " + somethingLongerThanTheScreenWidth(withArguments, andMore)"}})
	})
	await t.frames()
	let after = await page.evaluate(() => view.lines.vline(9).rows)
	check("wrapping: rows update after an edit", after > before, `${before} -> ${after}`)

	// Far jump: content is measured and drawn where expected.
	let far = await page.evaluate(async () => {
		let pos = view.state.doc.line(15000).from
		view.scrollPosIntoView(pos)
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let c = view.coordsAtPos(pos), rect = view.scrollDOM.getBoundingClientRect()
		return {inView: c.top >= rect.top - 1 && c.bottom <= rect.bottom + 1, coverage: view.debug.coverage}
	})
	check("wrapping: far jump shows the target line", far.inView, JSON.stringify(far))

	// Apps that reuse one view for several files (Acode) swap states with
	// different line counts: the rows must follow, both ways.
	let swap = await page.evaluate(async () => {
		let frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let original = view.state, EditorState = original.constructor
		// Wrapping as a view option, so it holds for states without
		// EditorView.lineWrapping.
		view.reconfigure({lineWrapping: true})
		view.setState(EditorState.create({doc: ""}))
		await frames()
		let empty = {rows: view.lines.totalRows, lines: view.state.doc.lines, viewport: view.viewport}
		view.setState(EditorState.create({doc: Array.from({length: 3000}, (_, i) => "line " + i).join("\n")}))
		await frames()
		view.scrollTop = 1e9
		await frames()
		let longer = {rows: view.lines.totalRows, lines: view.state.doc.lines, top: view.scrollTop,
			last: view.lineBlockAt(view.state.doc.length).top != null}
		// Plugins of the new state read the viewport while they're created
		// (search highlighting, color chips): it must be the new document's.
		let created = []
		let reader = cmApi.ViewPlugin.define(v => { created.push(v.viewport); return {} })
		view.setState(EditorState.create({doc: "a\nb", extensions: [reader]}))
		await frames()
		longer.created = created[0]
		view.setState(original)
		view.reconfigure({lineWrapping: undefined})
		await frames()
		return {empty, longer, restored: view.lines.totalRows > view.state.doc.lines}
	})
	check("wrapping: setState to a shorter document resizes the rows",
		swap.empty.rows == 1 && swap.empty.viewport.to == 0, JSON.stringify(swap.empty))
	check("wrapping: setState to a longer document resizes the rows",
		swap.longer.rows == swap.longer.lines && swap.longer.top > 0 && swap.longer.last, JSON.stringify(swap.longer))
	check("wrapping: plugins created by setState see the new document's viewport",
		swap.longer.created?.from == 0 && swap.longer.created?.to == 3, JSON.stringify(swap.longer.created))
	check("wrapping: setState back keeps wrapped rows", swap.restored)
	// Switching tabs: a pixel scroll position saved before leaving a
	// document lands on the same line when it's shown again.
	let back = await page.evaluate(async () => {
		let frame = () => new Promise(r => requestAnimationFrame(r))
		let topLine = () => view.state.doc.lineAt(view.posAtCoords({x: 100, y: view.scrollDOM.getBoundingClientRect().top + 2})).number
		view.scrollTop = view.lineTop(15000)
		await frame(); await frame()
		let saved = view.scrollTop, line = topLine(), a = view.state
		view.setState(cmApi.EditorState.create({doc: "other\ndocument", extensions: [cmApi.EditorView.lineWrapping]}))
		await frame()
		view.setState(a)
		view.scrollTop = saved
		await frame()
		return {line, after: topLine(), saved, now: view.scrollTop}
	})
	check("wrapping: saved scroll position shows the same line after switching back", back.after == back.line, JSON.stringify(back))
	// The text input follows setState: after switching from a long
	// document (cursor near its end) to a short one, focusing and typing
	// works (the input's window into the old document would be out of range).
	await page.evaluate(() => {
		view.dispatch({selection: {anchor: view.state.doc.length - 5}})
		view.setState(cmApi.EditorState.create({doc: "short"}))
		view.focus()
	})
	await t.frames()
	await page.keyboard.type("ab")
	await t.frames()
	let typed = await page.evaluate(() => view.state.doc.toString())
	check("wrapping: typing after setState to a shorter document", typed.length == 7 && typed.includes("ab"), JSON.stringify(typed))
	check("wrapping: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Folding, widgets and plugins ---------------------------------------------
{
	let t = await open("kind=js&lines=2000&ext=full")
	let {page} = t
	let lh = await page.evaluate(() => view.lineHeight)
	let numberAt = n => page.evaluate(n => {
		let rect = view.scrollDOM.getBoundingClientRect()
		return {x: rect.left + view.gutterWidth / 2, y: rect.top + view.lineTop(n) - view.scrollTop + view.lineHeight / 2}
	}, n)

	let rows0 = await page.evaluate(() => view.lines.totalRows)
	// Fold by tapping line 8's number (the function header).
	let p = await numberAt(8)
	await t.tap(p.x, p.y)
	let folded = await page.evaluate(() => ({next: view.lineAtHeight(view.lineTop(8) + view.lineHeight), rows: view.lines.totalRows,
		hidden: view.lines.hidden(12)}))
	check("folding: gutter tap folds", folded.next == 24 && folded.hidden, JSON.stringify(folded))
	check("folding: rows shrink", folded.rows == rows0 - 15, JSON.stringify({...folded, rows0}))

	// Cursor motion treats the fold as atomic.
	await page.evaluate(() => {
		let l = view.state.doc.line(8)
		view.dispatch({selection: {anchor: l.to}})
		view.focus()
	})
	await t.key("ArrowRight")
	let s = await t.sel()
	check("folding: ArrowRight skips the folded range", s.line == 23, JSON.stringify(s))
	await page.evaluate(() => view.dispatch({selection: {anchor: view.state.doc.line(8).from + 2}}))
	await t.key("ArrowDown")
	s = await t.sel()
	check("folding: ArrowDown goes past the fold", s.line == 24, JSON.stringify(s))

	// Tap the placeholder to unfold.
	let ph = await page.evaluate(() => {
		let vl = view.lines.vline(8), piece = vl.pieces.find(p => p.kind == 2)
		let c = view.coordsAtPos(vl.from + piece.from)
		view.scrollLeft = Math.max(0, c.left - view.scrollDOM.getBoundingClientRect().left - 200)
		c = view.coordsAtPos(vl.from + piece.from)
		return {x: c.left + view.cellWidth * piece.cells / 2, y: (c.top + c.bottom) / 2}
	})
	await t.frames()
	await t.tap(ph.x, ph.y)
	check("folding: placeholder tap unfolds", await page.evaluate(r => !view.lines.hidden(12) && view.lines.totalRows == r, rows0))

	// The syntax driver's tree is shared with the state, so folding works
	// near the end of the document too.
	await sleep(600)
	let tree = await page.evaluate(() => ({len: cmApi.syntaxTree(view.state).length, doc: view.state.doc.length}))
	check("folding: state syntax tree covers the document", tree.len == tree.doc, JSON.stringify(tree))
	let lateFold = await page.evaluate(() => {
		let n = view.state.doc.lines - 30
		while (n < view.state.doc.lines && !/\{\s*$/.test(view.state.doc.line(n).text)) n++
		return {n, folded: view.toggleFold(n), hidden: view.lines.hidden(n + 1)}
	})
	check("folding: fold near the end", lateFold.folded && lateFold.hidden, JSON.stringify(lateFold))

	// Inline widgets (sample inlay hints) take cells after their position.
	let wid = await page.evaluate(async () => {
		view.scrollTop = 0
		view.scrollLeft = 0
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let l = view.state.doc.line(9), pos = l.from + l.text.indexOf("cache") + 5
		let a = view.coordsAtPos(pos), b = view.coordsAtPos(pos + 1)
		let p = view.lines.vline(9).pieces?.find(p => p.kind == 1)
		return {gap: (b.left - a.left) / view.cellWidth, cells: p?.cells, label: p?.label?.text}
	})
	check("widgets: inlay hint takes its label's cells", wid.label == ": number" && Math.abs(wid.gap - 1 - wid.cells) < 0.01, JSON.stringify(wid))

	// Indent guides: blank lines take their neighbours' indentation; the
	// active guide spans the block around the cursor.
	let guides = await page.evaluate(() => {
		let doc = view.state.doc, unit = view.indentUnit
		view.dispatch({selection: {anchor: doc.line(13).from + 6}})
		let blank = doc.line(28)
		return {unit, blank: blank.text, blankIndent: view.guideIndent(28, blank.text), active: view.activeGuide(),
			header: (view.dispatch({selection: {anchor: doc.line(11).to}}), view.activeGuide())}
	})
	check("guides: blank line uses neighbouring indent", guides.blank == "" && guides.blankIndent == 4, JSON.stringify(guides))
	check("guides: active guide spans the enclosing block", guides.active?.col == 8 && guides.active.first == 12 && guides.active.last == 16,
		JSON.stringify(guides.active))
	check("guides: block header shows its block's guide", guides.header?.col == 8 && guides.header.first == 12, JSON.stringify(guides.header))

	// The horizontal scroll range covers widgets, with room after the end.
	let end = await page.evaluate(async () => {
		view.scrollLeft = 1e6
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		view.scrollLeft = 1e6
		let l = view.state.doc.line(14), c = view.coordsAtPos(l.to), rect = view.scrollDOM.getBoundingClientRect()
		let room = (rect.right - c.left) / view.cellWidth
		view.scrollLeft = 0
		return {room}
	})
	check("scrolling: line end with widgets reachable, with room after", end.room >= 4, JSON.stringify(end))

	// Search panel (CodeMirror's own) shrinks the drawing surface.
	let h0 = await page.evaluate(() => view.height)
	await page.evaluate(() => { cmApi.openSearchPanel(view) })
	await sleep(100)
	let panel = await page.evaluate(() => ({panel: !!view.dom.querySelector(".cm-search"), h: view.height,
		focused: document.activeElement?.getAttribute("main-field") == "true"}))
	check("search: panel opens above the surface", panel.panel && panel.h < h0, JSON.stringify({...panel, h0}))
	await page.keyboard.type("Cache0")
	await page.keyboard.press("Enter")
	await t.frames()
	let found = await page.evaluate(() => {
		let m = view.state.selection.main
		return {text: view.state.sliceDoc(m.from, m.to), marks: view.decos.marks.length}
	})
	check("search: Enter selects the next match", found.text == "Cache0", JSON.stringify(found))
	check("search: matches drawn as marks", found.marks > 0, JSON.stringify(found))
	await page.evaluate(() => { cmApi.closeSearchPanel(view) })
	await sleep(100)
	check("search: closing restores the height", await page.evaluate(h0 => Math.abs(view.height - h0) < 1 && !view.dom.querySelector(".cm-search"), h0))

	// Autocomplete popup (CodeMirror's tooltip) and accepting a completion.
	await page.evaluate(() => {
		let l = view.state.doc.line(22)
		view.dispatch({selection: {anchor: l.to}})
		view.focus()
	})
	await t.key("Enter")
	await page.keyboard.type("retr")
	await page.waitForSelector(".cm-tooltip-autocomplete", {timeout: 3000}).catch(() => null)
	// CodeMirror creates tooltips off screen and positions them in its
	// next measure cycle, after a frame.
	await page.waitForFunction(() => (document.querySelector(".cm-tooltip-autocomplete")?.getBoundingClientRect().top ?? -1e4) > -1000,
		{timeout: 1000}).catch(() => null)
	let pop = await page.evaluate(() => {
		let el = document.querySelector(".cm-tooltip-autocomplete"), c = view.coordsAtPos(view.state.selection.main.head)
		let r = el?.getBoundingClientRect()
		return el ? {top: r.top, bottom: r.bottom, left: r.left, cursorTop: c.top, cursorBottom: c.bottom, cursorLeft: c.left} : null
	})
	check("autocomplete: popup shown next to the cursor", !!pop && (Math.abs(pop.top - pop.cursorBottom) < 12 || Math.abs(pop.bottom - pop.cursorTop) < 12),
		JSON.stringify(pop))
	// Completions ignore Enter for `interactionDelay` (75ms) after opening.
	await sleep(150)
	await t.key("Enter")
	let line = await page.evaluate(() => view.state.doc.lineAt(view.state.selection.main.head).text.trim())
	check("autocomplete: Enter accepts", line == "retries", line)

	// Lint (CodeMirror's linter field) draws wavy underlines.
	await sleep(700)
	let lint = await page.evaluate(() => view.decos.sets.length)
	check("lint: diagnostics provide decorations", lint >= 2, String(lint))

	// Hover tooltip from a mouse move.
	let hover = await page.evaluate(async () => {
		let pos = view.state.doc.line(16).from + view.state.doc.line(16).text.indexOf("result") + 2
		let c = view.coordsAtPos(pos)
		view.canvas.dispatchEvent(new MouseEvent("mousemove", {clientX: c.left + 2, clientY: c.top + 5, bubbles: true}))
		await new Promise(r => setTimeout(r, 600))
		return document.querySelector(".cm-tooltip-hover")?.textContent ?? null
	})
	check("hover: tooltip shown", hover == "result (6 chars)", String(hover))

	// Plugins follow the viewport: inlay hints appear far down after scrolling.
	let vp = await page.evaluate(async () => {
		let pos = view.state.doc.line(1500).from
		view.scrollPosIntoView(pos)
		for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r))
		return {viewport: view.viewport, hints: view.decos.points.filter(p => p.from > pos - 2000 && p.from < pos + 4000).length}
	})
	check("plugins: viewport-driven decorations follow scrolling", vp.hints > 0, JSON.stringify(vp))
	check("plugins: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Editor options, gutters, widgets, blocks -------------------------------------
{
	let t = await open("kind=js&lines=2000&ext=full&breakpoints=1")
	let {page} = t
	let lh = await page.evaluate(() => view.lineHeight)
	let rowPoint = (n, x) => page.evaluate((n, x) => {
		let rect = view.scrollDOM.getBoundingClientRect()
		return {x: rect.left + x, y: rect.top + view.lineTop(n) - view.scrollTop + view.lineHeight / 2}
	}, n, x)

	// Gutter: lint + breakpoint gutters share one narrow column.
	let g = await page.evaluate(() => ({left: view.gutterLeft, cols: view.gutterColumns.length}))
	check("gutter: marker gutters share one column", g.cols == 2 && g.left > 0 && g.left <= 16, JSON.stringify(g))
	let p = await rowPoint(12, 4)
	let before = await page.evaluate(() => view.state.selection.main.head)
	await t.tap(p.x, p.y)
	let bp = await page.evaluate(() => {
		let n = 0
		view.state.field(cmApi.breakpointState).between(0, view.state.doc.length, () => { n++ })
		return {n, head: view.state.selection.main.head}
	})
	check("gutter: tap toggles a breakpoint (CodeMirror gutter handler)", bp.n == 1, JSON.stringify(bp))
	check("gutter: gutter taps don't move the cursor", bp.head == before, JSON.stringify(bp))
	await sleep(500)
	p = await rowPoint(18, 4)
	await t.tap(p.x, p.y)
	await sleep(500)
	let tip = await page.evaluate(() => document.querySelector(".cm-tooltip-lint")?.textContent ?? null)
	check("gutter: tapping a lint marker opens its tooltip", tip == "Rethrowing loses context", String(tip))
	// The tooltip is positioned from the marker's (proxy) element: it
	// follows the line when the view scrolls.
	let tipTop = () => page.evaluate(() => document.querySelector(".cm-tooltip-lint")?.getBoundingClientRect().top ?? null)
	let tip0 = await tipTop()
	await page.evaluate(() => { view.scrollDOM.scrollTop += 60 })
	await t.frames()
	await sleep(100)
	let tip1 = await tipTop()
	check("gutter: the lint tooltip follows its line when scrolling", tip0 != null && tip1 != null && Math.abs(tip0 - 60 - tip1) < 2,
		JSON.stringify({tip0, tip1}))
	await page.evaluate(() => { view.scrollDOM.scrollTop -= 60 })
	await t.frames()

	// Overlay: no marker column, markers left of the numbers, taps there
	// go to the marker gutters, taps on a number still fold.
	await page.evaluate(() => { document.querySelector(".cm-tooltip-lint")?.remove() })
	let ov = await page.evaluate(async () => {
		let shared = {gutter: view.gutterWidth}
		view.reconfigure({gutterMarkers: "overlay"})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		return {shared, gutter: view.gutterWidth, left: view.gutterLeft, numberLeft: view.numberLeft(14), box: view.overlayBox(14),
			lineNumbers: view.lineNumbers}
	})
	check("gutter overlay: no marker column, a narrower gutter", ov.left == 0 && ov.gutter < ov.shared.gutter, JSON.stringify(ov))
	check("gutter overlay: markers go left of the number", ov.box.x + ov.box.w <= ov.numberLeft, JSON.stringify(ov))
	let bpCount = () => page.evaluate(() => {
		let n = []
		view.state.field(cmApi.breakpointState).between(0, view.state.doc.length, f => { n.push(view.state.doc.lineAt(f).number) })
		return n
	})
	await sleep(500)
	p = await rowPoint(14, 2)
	await t.tap(p.x, p.y)
	let afterTap = await bpCount()
	check("gutter overlay: a tap left of the number toggles a breakpoint", afterTap.includes(14), JSON.stringify(afterTap))
	await sleep(500)
	let nx = await page.evaluate(() => view.gutterRight - view.cellWidth / 2)
	p = await rowPoint(8, nx)
	await t.tap(p.x, p.y)
	let fold = await page.evaluate(() => ({last: view.lines.vline(8).last}))
	check("gutter overlay: a tap on the number still folds", fold.last > 8 && !(await bpCount()).includes(8), JSON.stringify(fold))
	await page.evaluate(async () => {
		if (view.lines.vline(8).last > 8) view.toggleFold(8)
		view.reconfigure({gutterMarkers: "shared"})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
	})

	// Touch slop: fingers may land a bit right of the marker column, and
	// near a line's edge for the neighbor's fold or lint marker.
	await page.evaluate(() => { document.querySelector(".cm-tooltip-lint")?.remove() })
	await sleep(500)
	let slopX = await page.evaluate(() => view.gutterLeft + 7)
	p = await rowPoint(19, slopX)
	await t.tap(p.x, p.y)
	await sleep(500)
	tip = await page.evaluate(() => [...document.querySelectorAll(".cm-tooltip-lint")].map(e => e.textContent).join("|"))
	check("gutter touch: a tap just right of the marker column opens the lint tooltip", tip.includes("Avoid console output"), String(tip))
	await page.evaluate(() => { document.querySelector(".cm-tooltip-lint")?.remove() })
	let foldable = await page.evaluate(() => ({f8: view.canFold(8), f9: view.canFold(9)}))
	let numX = await page.evaluate(() => view.gutterRight - view.cellWidth / 2)
	let edgePoint = (n, frac) => page.evaluate((n, x, frac) => {
		let rect = view.scrollDOM.getBoundingClientRect()
		return {x: rect.left + x, y: rect.top + view.lineTop(n) - view.scrollTop + view.lineHeight * frac}
	}, n, numX, frac)
	await sleep(500)
	p = await edgePoint(9, 0.5)
	await t.tap(p.x, p.y)
	let middle = await page.evaluate(() => view.lines.vline(8).last)
	await sleep(500)
	p = await edgePoint(9, 0.15)
	await t.tap(p.x, p.y)
	let edge = await page.evaluate(() => view.lines.vline(8).last)
	check("gutter touch: a tap near a line's edge folds the foldable line next to it", foldable.f8 && !foldable.f9 && middle == 8 && edge > 8,
		JSON.stringify({foldable, middle, edge}))
	await page.evaluate(() => { if (view.lines.vline(8).last > 8) view.toggleFold(8) })
	let unfocused = await page.evaluate(() => { view.contentDOM.blur(); return view.state.selection.main.head })
	await sleep(500)
	p = await edgePoint(13, 0.5)
	await t.tap(p.x, p.y)
	let nf = await page.evaluate(() => ({focus: view.hasFocus, head: view.state.selection.main.head}))
	check("gutter touch: a tap on a number with nothing to fold doesn't focus (no keyboard)", !nf.focus && nf.head == unfocused, JSON.stringify(nf))

	// Rainbow brackets: depth from the syntax tree.
	await page.evaluate(() => view.reconfigure({rainbowBrackets: true}))
	let rb = await page.evaluate(() => {
		let line = view.state.doc.line(8)
		return {text: line.text, brackets: view.lineBrackets(8)}
	})
	let paren = rb.text.indexOf("("), brace = rb.text.indexOf("{")
	let br = rb.brackets ?? []
	let colorOf = off => { for (let i = 0; i < br.length; i += 2) if (br[i] == off) return br[i + 1]; return -1 }
	check("rainbow: nested brackets get successive colors", colorOf(paren) == 0 && colorOf(brace) == 1 && colorOf(rb.text.lastIndexOf("{")) == 0,
		JSON.stringify(rb))
	let inString = await page.evaluate(() => {
		let n = 14, text = view.state.doc.line(n).text, b = view.lineBrackets(n) ?? []
		let start = text.indexOf("`"), end = text.lastIndexOf("`")
		for (let i = 0; i < b.length; i += 2) if (b[i] > start && b[i] < end && text[b[i]] == "?") return true
		return false
	})
	check("rainbow: brackets in strings are skipped", !inString)

	// Relative line numbers are drawn per frame, not in the scene.
	await page.evaluate(() => view.reconfigure({lineNumbers: "relative"}))
	await t.frames()
	check("line numbers: relative mode", await page.evaluate(() => view.debug.gutter == 0 && view.dynGlyphs.count > 20))
	await page.evaluate(() => view.reconfigure({lineNumbers: true}))

	// Whitespace markers follow CodeMirror's highlightWhitespace extension.
	let ws = await page.evaluate(async () => {
		view.reconfigure({showWhitespace: undefined})
		let off = view.whitespace
		view.dispatch({effects: cmApi.StateEffect.appendConfig.of(cmApi.highlightWhitespace())})
		return {off, on: view.whitespace}
	})
	check("whitespace: CodeMirror's highlightWhitespace turns markers on", ws.off == null && ws.on?.spaces == true, JSON.stringify(ws))

	// Widgets: Acode-style DOM color chips become swatches; canvas-drawn widgets.
	let chip = await page.evaluate(() => {
		let vl = view.lines.vline(27), p = vl.pieces?.find(p => p.label && !p.label.text && !p.label.draw)
		let bar = vl.pieces?.find(p => p.label?.draw)
		return {cells: p?.label.cells, rounded: p?.label.style?.rounded, bar: bar?.cells}
	})
	check("widgets: DOM color chip drawn as a rounded swatch", chip.cells > 1 && chip.cells < 2.5 && chip.rounded, JSON.stringify(chip))
	check("widgets: canvas-drawn widget takes its cells", chip.bar == 3.5, JSON.stringify(chip))

	// Inline widgets are not cursor stops (like CodeMirror and VS Code):
	// a position sits after a `side: -1` widget (the color chip, the size
	// bar) and before a `side: 1` one (an inlay hint), arrows pass through
	// them with the character next to them, and a tap on a widget places
	// the cursor at its position.
	{
		let w = await page.evaluate(() => {
			let line = view.state.doc.line(27), size = line.text.indexOf("size:")
			let chip = line.from + line.text.indexOf("#"), bar = line.from + line.text.indexOf("}", size)
			let l9 = view.state.doc.line(9), hint = l9.from + l9.text.indexOf("cache") + 5
			view.scrollTop = 0
			view.scrollPosIntoView(chip)
			view.scrollLeft = Math.max(0, view.posCoords(chip).x * view.cellWidth - 60)
			return {chip, bar, hint, cw: view.cellWidth}
		})
		await t.frames()
		/// Client x of a position's cursor, and of the widget at it.
		let geo = pos => page.evaluate(pos => {
			let r = view.scrollDOM.getBoundingClientRect(), cw = view.cellWidth
			let toX = col => r.left + view.contentLeft + col * cw - view.scrollLeft
			let c = view.posCoords(pos), vl = c.vl, p = vl.pieces.find(p => p.kind == 1 && p.from == pos - vl.from)
			let top = r.top + view.rowTop(c.row) - view.scrollTop
			return {x: toX(c.x), left: toX(p.col), right: toX(p.col + p.cells), y: top + view.lineHeight / 2, top, bottom: top + view.lineHeight}
		}, pos)
		let drawn = () => page.evaluate(() => {
			let m = view.state.selection.main, c = view.posCoords(m.head, m.assoc || 1), r = view.scrollDOM.getBoundingClientRect()
			return {head: m.head, x: r.left + view.contentLeft + c.x * view.cellWidth - view.scrollLeft}
		})
		let at = async (pos, x) => {
			let d = await drawn()
			return d.head == pos && Math.abs(d.x - x) < 1 ? true : JSON.stringify({...d, want: {pos, x}})
		}
		let cx = pos => page.evaluate(p => {
			let r = view.scrollDOM.getBoundingClientRect()
			return r.left + view.contentLeft + view.posCoords(p).x * view.cellWidth - view.scrollLeft
		}, pos)
		let walk = async (pos, keys, want) => {
			await page.evaluate(p => view.dispatch({selection: {anchor: p}}), pos)
			let got = []
			for (let k of keys) {
				await t.key(k)
				let d = await drawn()
				got.push([d.head, Math.round(d.x * 10) / 10])
			}
			let ok = got.every(([h, x], i) => h == want[i][0] && Math.abs(x - want[i][1]) < 1)
			return ok ? true : JSON.stringify({got, want})
		}
		let tapAt = async (x, y) => { await sleep(450); await t.tap(x, y) }
		let chip = await geo(w.chip), bar = await geo(w.bar), r
		check("widgets: a position sits after a side -1 widget", Math.abs(chip.x - chip.right) < 0.5 && Math.abs(bar.x - bar.right) < 0.5,
			JSON.stringify({chip, bar}))
		for (let [name, g, pos] of [["chip", chip, w.chip], ["drawn widget", bar, w.bar]]) {
			for (let f of [0.25, 0.75]) {
				await tapAt(g.left + (g.right - g.left) * f, g.y)
				r = await at(pos, g.x)
				check(`widgets: a tap on a ${name} (${f}) places the cursor at it`, r === true, r)
			}
		}
		check("widgets: the cursor next to a widget is drawn there", Math.abs((await t.drawnCursorX(bar.x, bar.top, bar.bottom)) - bar.x) < 1.5)

		r = await walk(w.chip - 1, ["ArrowRight", "ArrowRight"], [[w.chip, chip.x], [w.chip + 1, await cx(w.chip + 1)]])
		check("widgets: ArrowRight passes a character and the chip after it", r === true, r)
		r = await walk(w.chip + 1, ["ArrowLeft", "ArrowLeft"], [[w.chip, chip.x], [w.chip - 1, await cx(w.chip - 1)]])
		check("widgets: ArrowLeft passes a character, then the chip with the one before it", r === true, r)

		await page.evaluate(() => { view.scrollLeft = 0 })
		await t.frames()
		let hint = await geo(w.hint)
		check("widgets: a position sits before a side 1 widget (inlay hint)", Math.abs(hint.x - hint.left) < 0.5, JSON.stringify(hint))
		r = await walk(w.hint - 1, ["ArrowRight", "ArrowRight"], [[w.hint, hint.x], [w.hint + 1, await cx(w.hint + 1)]])
		check("widgets: ArrowRight stops before an inlay hint, then passes it", r === true, r)
		await page.evaluate(() => { view.scrollLeft = 0 })
		await t.frames()
	}

	// Block widgets: rows of their own, real DOM, clickable, skipped by cursor motion.
	let blk = await page.evaluate(() => {
		let vl = view.lines.vline(7)
		return {blockRows: vl.blockRows, gap: view.lineTop(8) - view.lineTop(7), lh: view.lineHeight,
			total: view.lines.totalRows, lines: view.state.doc.lines}
	})
	check("blocks: widget rows between lines", blk.blockRows == 1 && Math.abs(blk.gap - 2 * blk.lh) < 0.5, JSON.stringify(blk))
	let btn = await page.evaluate(() => {
		let b = [...document.querySelectorAll(".demo-lens button")].find(b => b.textContent.includes("loadResource0") && b.offsetParent && b.parentElement.style.visibility != "hidden")
		if (!b) return null
		let r = b.getBoundingClientRect()
		return {x: r.left + r.width / 2, y: r.top + r.height / 2}
	})
	let head0 = await page.evaluate(() => view.state.selection.main.head)
	if (btn) await t.tap(btn.x, btn.y)
	let clicked = await page.evaluate(() => [...document.querySelectorAll(".demo-lens button")].some(b => b.textContent == "✓ Ran loadResource0"))
	check("blocks: widget DOM gets taps", !!btn && clicked, JSON.stringify(btn))
	check("blocks: tapping a widget doesn't move the cursor", await page.evaluate(h => view.state.selection.main.head == h, head0))
	await page.evaluate(() => { let l = view.state.doc.line(7); view.dispatch({selection: {anchor: l.from + 1}}); view.focus() })
	await t.key("ArrowDown")
	let after = await t.sel()
	check("blocks: ArrowDown skips the widget rows", after.line == 8, JSON.stringify(after))

	// Block widgets before line 1: drawn above it (a head that pushes
	// row 0 down), at the top of the document.
	let head = await page.evaluate(async () => {
		let {StateEffect, StateField, Decoration, WidgetType, EditorView} = cmApi
		class Banner extends WidgetType {
			eq() { return true }
			toDOM() {
				let el = document.createElement("div")
				el.className = "demo-banner"
				el.style.cssText = "height: 40px; background: rgba(200, 120, 0, 0.3)"
				el.textContent = "banner"
				return el
			}
		}
		let field = StateField.define({
			create: () => Decoration.set([Decoration.widget({widget: new Banner(), block: true, side: -1}).range(0)]),
			update: (v, tr) => v.map(tr.changes),
			provide: f => EditorView.decorations.from(f)
		})
		view.scrollTop = 0
		let headBefore = view.lines.headRows
		view.dispatch({effects: StateEffect.appendConfig.of(field), selection: {anchor: 3}})
		view.focus()
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let el = document.querySelector(".demo-banner").getBoundingClientRect()
		let c = view.coordsAtPos(3), surface = view.scrollDOM.getBoundingClientRect()
		return {headBefore, headRows: view.lines.headRows, rows1: view.lines.vline(1).blockRows, top: view.scrollTop, lh: view.lineHeight,
			bannerTop: el.top - surface.top, bannerBottom: el.bottom - surface.top, visible: getComputedStyle(document.querySelector(".demo-banner")).visibility,
			lineTop: c.top - surface.top, x: c.left, cTop: c.top, cBottom: c.bottom, block: view.lineBlockAt(0).top}
	})
	check("blocks: a widget before line 1 takes rows above it", head.headRows - head.headBefore == Math.ceil(40 / head.lh - 0.01) && head.rows1 == 0, JSON.stringify(head))
	check("blocks: a widget before line 1 is drawn above it", head.visible == "visible" &&
		head.bannerBottom <= head.lineTop + 0.5 && head.lineTop - head.bannerTop >= 40 && head.top == 0, JSON.stringify(head))
	check("blocks: lineBlockAt(line 1) starts below the head", Math.abs(head.block - head.headRows * head.lh) < 0.5, JSON.stringify(head))
	let hx = await t.drawnCursorX(head.x, head.cTop, head.cBottom)
	check("blocks: the cursor on line 1 is drawn below the head", hx != null && Math.abs(hx - head.x) < 1.5, String(hx))
	let tapPos = await page.evaluate(() => {
		let c = view.coordsAtPos(view.state.doc.line(1).from + 6)
		return {x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2}
	})
	await t.tap(tapPos.x, tapPos.y)
	let ts = await t.sel()
	check("blocks: a tap on line 1 under the head lands on it", ts.line == 1 && Math.abs(ts.col - 6) <= 1, JSON.stringify(ts))
	await page.evaluate(() => { view.dispatch({selection: {anchor: view.state.doc.line(2).from + 1}}); view.focus() })
	await t.key("ArrowUp")
	ts = await t.sel()
	check("blocks: ArrowUp reaches line 1 under the head", ts.line == 1, JSON.stringify(ts))
	await t.key("ArrowUp")
	ts = await t.sel()
	check("blocks: ArrowUp from line 1 goes to the document start", ts.head == 0, JSON.stringify(ts))
	let anchored = await page.evaluate(async () => {
		let {StateEffect, Decoration, WidgetType, EditorView} = cmApi
		class Tall extends WidgetType {
			eq() { return true }
			get estimatedHeight() { return 90 }
			toDOM() { let el = document.createElement("div"); el.style.height = "90px"; return el }
		}
		view.scrollTop = view.lineTop(50) + 3
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let before = view.lineTop(50) - view.scrollTop, rows = view.lines.headRows
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.decorations.of(
			Decoration.set([Decoration.widget({widget: new Tall(), block: true, side: -1}).range(0)])))})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		return {before, after: view.lineTop(50) - view.scrollTop, rows, rowsAfter: view.lines.headRows}
	})
	check("blocks: a head widget appearing above the view keeps the text in place",
		anchored.rowsAfter > anchored.rows && Math.abs(anchored.before - anchored.after) < 0.5, JSON.stringify(anchored))

	// Block replaces over whole lines (the demo collapses every other
	// Widget class's internals, like @codemirror/merge's collapseUnchanged):
	// the widget's DOM fills rows of its own, without text or numbers.
	let cov = await page.evaluate(async () => {
		let doc = view.state.doc, c = 0
		for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text.startsWith("class Widget1 ")) { c = n; break }
		view.scrollTop = view.lineTop(c) - 100
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let vl = view.lines.vline(c + 1), lh = view.lineHeight
		let el = [...document.querySelectorAll(".demo-collapsed")].find(e => e.title.startsWith("Widget1 "))
		let r = el.getBoundingClientRect(), surface = view.scrollDOM.getBoundingClientRect()
		return {c, cover: !!vl.cover, first: vl.first, last: vl.last, closing: doc.line(vl.last + 1).text, rows: vl.rows, lh,
			hidden: view.lines.hidden(c + 2), gap: view.lineTop(vl.last + 1) - view.lineTop(c + 1), above: view.lineTop(c + 1) - view.lineTop(c),
			domTop: r.top - surface.top + view.scrollTop, domBottom: r.bottom - surface.top + view.scrollTop, top: view.lineTop(c + 1),
			visible: getComputedStyle(el).visibility, number: view.scene.gutterSegs.has(c + 1), numberAfter: view.scene.gutterSegs.has(vl.last + 1),
			block: view.lineBlockAt(vl.from).type, blockHeight: view.lineBlockAt(vl.from).height, from: vl.from, to: vl.to}
	})
	check("block replace: covers whole lines as one block", cov.cover && cov.first == cov.c + 1 && cov.closing == "}" && cov.hidden && cov.rows >= 1,
		JSON.stringify(cov))
	check("block replace: takes the widget's rows", Math.abs(cov.gap - cov.rows * cov.lh) < 0.5 && Math.abs(cov.above - cov.lh) < 0.5, JSON.stringify(cov))
	check("block replace: the widget DOM fills its rows", cov.visible == "visible" && Math.abs(cov.domTop - cov.top) < 1 &&
		cov.domBottom <= cov.top + cov.rows * cov.lh + 0.5, JSON.stringify(cov))
	check("block replace: no line number on its rows", !cov.number && cov.numberAfter, JSON.stringify(cov))
	check("block replace: lineBlockAt is a WidgetRange", cov.block == 3 && Math.abs(cov.blockHeight - cov.rows * cov.lh) < 0.5, JSON.stringify(cov))
	await page.evaluate(c => { view.dispatch({selection: {anchor: view.state.doc.line(c).from + 6}}); view.focus() }, cov.c)
	let steps = []
	for (let k of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowLeft"]) {
		await t.key(k)
		steps.push(await page.evaluate(() => view.state.selection.main.head))
	}
	let next = await page.evaluate(n => view.state.doc.line(n).from, cov.last + 1)
	check("block replace: ArrowDown stops at its start, then passes it", steps[0] == cov.from && steps[1] > cov.to && steps[1] <= next + 1, JSON.stringify({steps, cov}))
	check("block replace: ArrowUp stops at its end, then passes it", steps[2] == cov.to && steps[3] < cov.from - 1, JSON.stringify({steps, cov}))
	check("block replace: ArrowRight/Left step over the hidden text", steps[4] == cov.from && steps[5] == cov.to && steps[6] == next && steps[7] == cov.to,
		JSON.stringify({steps, cov}))
	let wrapRows = await page.evaluate(async c => {
		view.reconfigure({lineWrapping: true})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let vl = view.lines.vline(c + 1), gap = view.lineTop(vl.last + 1) - view.lineTop(c + 1)
		view.reconfigure({lineWrapping: false})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		return {cover: !!vl.cover, rows: vl.rows, gap}
	}, cov.c)
	check("block replace: same rows with wrapping", wrapRows.cover && wrapRows.rows == cov.rows && Math.abs(wrapRows.gap - cov.rows * cov.lh) < 0.5,
		JSON.stringify(wrapRows))
	let bar = await page.evaluate(() => {
		let el = [...document.querySelectorAll(".demo-collapsed")].find(e => e.title.startsWith("Widget1 "))
		// Its visible part: block widgets are as wide as the longest line.
		let r = el.getBoundingClientRect()
		return {x: r.left + 40, y: r.top + r.height / 2}
	})
	await sleep(450)
	await t.tap(bar.x, bar.y)
	await t.frames()
	let expanded = await page.evaluate(c => ({cover: !!view.lines.vline(c + 1).cover, rows: view.lines.vline(c + 1).rows,
		number: view.scene.gutterSegs.has(c + 1), text: view.state.doc.line(c + 1).text}), cov.c)
	check("block replace: its widget gets taps (expands here), then the lines are back", !expanded.cover && expanded.rows == 1 && expanded.number,
		JSON.stringify(expanded))

	// Without a widget, a block replace hides its lines (no rows).
	let hid = await page.evaluate(async c => {
		let {StateEffect, Decoration, EditorView} = cmApi, doc = view.state.doc
		let a = c + 25, b = c + 27
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.decorations.of(
			Decoration.set([Decoration.replace({block: true}).range(doc.line(a).from, doc.line(b).to)])))})
		view.scrollTop = view.lineTop(a) - 100
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		view.dispatch({selection: {anchor: doc.line(a - 1).from + 2}})
		view.focus()
		return {a, b, rows: view.lines.vline(a).rows, gap: view.lineTop(b + 1) - view.lineTop(a - 1), lh: view.lineHeight,
			rowsBefore: view.lines.vline(a - 1).rows + view.lines.vline(a - 1).blockRows, number: view.scene.gutterSegs.has(a)}
	}, cov.c)
	check("block replace without a widget hides its lines", hid.rows == 0 && Math.abs(hid.gap - hid.rowsBefore * hid.lh) < 0.5 && !hid.number,
		JSON.stringify(hid))
	await t.key("ArrowDown")
	let past = await t.sel()
	check("block replace without a widget: ArrowDown skips the hidden lines", past.line == hid.b + 1, JSON.stringify({past, hid}))

	// Block replaces starting or ending inside a line, like CodeMirror:
	// the text before ends its row, the widget gets rows of its own, the
	// text after starts a row at the left edge.
	let mid = await page.evaluate(async () => {
		let {StateEffect, Decoration, WidgetType, EditorView} = cmApi, doc = view.state.doc
		let frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		class Mid extends WidgetType {
			constructor(t) { super(); this.t = t }
			eq(o) { return o.t == this.t }
			toDOM() { let el = document.createElement("div"); el.className = "probe-" + this.t; el.textContent = this.t; el.style.height = "30px"; return el }
		}
		let n = 0, m = 0
		for (let i = 1; i <= doc.lines; i++) {
			let text = doc.line(i).text
			if (!n && text.startsWith("\tconst cache = new Cache5(")) n = i
			if (!m && text.startsWith("\tconst cache = new Cache6(")) m = i
		}
		let A = doc.line(n).from + 7, B = doc.line(n + 1).from + 10
		// Starting at a line start: the number goes to the text after.
		let A2 = doc.line(m).from, B2 = doc.line(m + 1).from + 10
		view.dispatch({effects: StateEffect.appendConfig.of(EditorView.decorations.of(Decoration.set([
			Decoration.replace({widget: new Mid("mid"), block: true}).range(A, B),
			Decoration.replace({widget: new Mid("start"), block: true}).range(A2, B2)])))})
		view.scrollTop = view.lineTop(n) - 100
		view.scrollLeft = 0
		await frames()
		let lh = view.lineHeight, vl = view.lines.vline(n), top = view.lineTop(n), s = view.scrollDOM.getBoundingClientRect()
		let rel = c => ({x: c.left - s.left, y: c.top - s.top + view.scrollTop})
		let el = document.querySelector(".probe-mid").getBoundingClientRect()
		let E = view.state.selection.constructor, steps = [], c = E.cursor(doc.line(n).from + 3)
		for (let i = 0; i < 4; i++) { c = view.moveVertically(c, i < 2); steps.push(c.head) }
		let chars = [], h = E.cursor(A - 1)
		for (let i = 0; i < 3; i++) { h = view.moveByChar(h, true); chars.push(h.head) }
		let after = rel(view.coordsAtPos(B + 3, 1))
		let afterHit = view.posAtCoords({x: after.x + s.left + 1, y: after.y - view.scrollTop + s.top + lh / 2})
		view.scrollTop = view.lineTop(m) - 100
		await frames()
		let vm = view.lines.vline(m), g = view.scene.gutterSegs.get(m)
		let res = {n, A, B, lh, rows: vl.rows, inner: vl.inner?.map(b => [b.row, b.rows]), hidden: view.lines.hidden(n + 1), top,
			widgetTop: el.top - s.top + view.lineTop(n) - 100, num: view.scene.gutterSegs.has(n), num2: view.scene.gutterSegs.has(n + 1),
			before: rel(view.coordsAtPos(A, -1)), beforeChar: rel(view.coordsAtPos(A - 1, 1)), after, lineStart: rel(view.coordsAtPos(doc.line(n).from, 1)),
			steps, chars, afterHit, startNum: g && {num: g.num, row: g.row - view.lines.rowOf(m)}, startLine: doc.lineAt(B2).number,
			startInner: vm.inner?.map(b => [b.row, b.rows]), cw: view.cellWidth}
		view.reconfigure({lineWrapping: true})
		await frames()
		res.wrap = {flush: view.lines.vline(n).flush, x: rel(view.coordsAtPos(B, 1)).x, start: rel(view.coordsAtPos(doc.line(n).from, 1)).x}
		view.reconfigure({lineWrapping: false})
		await frames()
		return res
	})
	let wr = mid.inner?.[0]?.[1] ?? 0
	check("mid-line block replace: text, widget rows, text", mid.inner?.[0]?.[0] == 1 && wr >= 1 && mid.rows == wr + 2 && mid.hidden, JSON.stringify(mid))
	check("mid-line block replace: the widget sits between the text rows", Math.abs(mid.widgetTop - (mid.top + mid.lh)) < 1, JSON.stringify(mid))
	check("mid-line block replace: line number on the first text row only", mid.num && !mid.num2, JSON.stringify(mid))
	check("mid-line block replace: its start ends the text before", Math.abs(mid.before.y - mid.top) < 1 &&
		Math.abs(mid.before.x - (mid.beforeChar.x + mid.cw)) < 1, JSON.stringify(mid))
	check("mid-line block replace: the text after starts a row at the left edge", Math.abs(mid.after.y - (mid.top + (wr + 1) * mid.lh)) < 1 &&
		Math.abs(mid.after.x - (mid.lineStart.x + 3 * mid.cw)) < 1 && mid.afterHit == mid.B + 3, JSON.stringify(mid))
	check("mid-line block replace: ArrowDown/Up stop at its edges", mid.steps[0] == mid.A && mid.steps[1] > mid.B && mid.steps[2] == mid.B &&
		mid.steps[3] < mid.A, JSON.stringify(mid))
	check("mid-line block replace: ArrowRight steps over it", mid.chars.join() == [mid.A, mid.B, mid.B + 1].join(), JSON.stringify(mid))
	check("block replace at a line start: the number goes to the text after (its line)", mid.startInner?.[0]?.[0] == 0 &&
		mid.startNum?.num == mid.startLine && mid.startNum?.row == mid.startInner[0][1], JSON.stringify(mid))
	check("mid-line block replace: the text after starts flush when wrapping", Math.abs(mid.wrap.x - mid.wrap.start) < 1, JSON.stringify(mid.wrap))

	// Like CodeMirror, block widgets scroll with the text, under the gutter.
	let clip = await page.evaluate(async () => {
		view.scrollTop = 0
		view.scrollLeft = 120
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let lens = [...document.querySelectorAll(".demo-lens")].find(e => e.style.visibility != "hidden")
		let surface = view.scrollDOM.getBoundingClientRect(), r = lens.getBoundingClientRect()
		let hit = document.elementFromPoint(surface.left + view.gutterWidth - 3, r.top + r.height / 2)
		let res = {lens: r.left - surface.left, layer: view.blocks.dom.getBoundingClientRect().left - surface.left, gw: view.gutterWidth,
			coversGutter: lens.contains(hit)}
		view.scrollLeft = 0
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		return res
	})
	check("block widgets scroll with the text, under the gutter", clip.layer == clip.gw && clip.lens == clip.gw - 120 && !clip.coversGutter,
		JSON.stringify(clip))

	// EditorView.findFromDOM finds canvas views from their DOM.
	let found = await page.evaluate(() => {
		let F = el => cmApi.EditorView.findFromDOM(el) === view
		let inline = view.decos.widgetElement(view.decos.points.find(p => !p.block && !p.blockReplace && p.deco.spec.widget).deco.spec.widget)
		return {dom: F(view.dom), scroll: F(view.scrollDOM), content: F(view.contentDOM), container: F(view.dom.parentElement),
			block: F(document.querySelector(".demo-lens")), inline: F(inline), other: cmApi.EditorView.findFromDOM(document.createElement("div")),
			own: view.constructor.findFromDOM(view.dom) === view}
	})
	check("findFromDOM: a view from its dom, scrollDOM, contentDOM or a container", found.dom && found.scroll && found.content && found.container && found.own,
		JSON.stringify(found))
	check("findFromDOM: from a widget's DOM, null elsewhere", found.block && found.inline && found.other === null, JSON.stringify(found))

	// Gutter element classes: gutterLineClass across the gutter, a
	// marker's elementClass in its column, lineNumberMarkers' in the numbers.
	let gc = await page.evaluate(async () => {
		let {StateEffect, EditorView, gutter, GutterMarker, gutterLineClass, lineNumberMarkers, RangeSet} = cmApi, doc = view.state.doc
		let cls = c => new (class extends GutterMarker { constructor() { super(); this.elementClass = c } })()
		let [a, b, c] = [10, 12, 14].map(n => doc.line(n).from)
		view.dispatch({effects: StateEffect.appendConfig.of([
			gutterLineClass.of(RangeSet.of([cls("probe-line").range(a)])),
			lineNumberMarkers.of(RangeSet.of([cls("probe-num").range(c)])),
			gutter({class: "probe-gutter", markers: () => RangeSet.of([cls("probe-cell").range(b)])}),
			EditorView.theme({".probe-line": {background: "rgb(255, 0, 0)"}, ".probe-gutter .probe-cell": {background: "rgb(0, 0, 255)"},
				".cm-lineNumbers .probe-num": {background: "rgb(0, 255, 0)"}})
		])})
		view.scrollTop = 0
		view.scrollLeft = 0
		for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 30))
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let s = view.scrollDOM.getBoundingClientRect()
		let y = n => { let c = view.coordsAtPos(doc.line(n).from); return c.top + 3 }
		return {left: s.left, marker: s.left + 1, numbers: s.left + view.gutterLeft + 1, lines: [10, 12, 14, 16].map(y)}
	})
	let pixel = async (x, y) => {
		let png = await page.screenshot({clip: {x, y, width: 1, height: 1}, encoding: "base64"})
		return page.evaluate(async png => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, 1, 1).data
			return [d[0], d[1], d[2]]
		}, png)
	}
	let px = {}
	for (let [i, n] of [10, 12, 14, 16].entries()) px[n] = {marker: await pixel(gc.marker, gc.lines[i]), numbers: await pixel(gc.numbers, gc.lines[i])}
	let red = p => p[0] > 180 && p[1] < 90 && p[2] < 90, blue = p => p[2] > 180 && p[0] < 90, green = p => p[1] > 180 && p[0] < 90 && p[2] < 90
	let plain = p => !red(p) && !blue(p) && !green(p)
	check("gutter: gutterLineClass tints the whole gutter of its line", red(px[10].marker) && red(px[10].numbers), JSON.stringify(px))
	check("gutter: a marker's elementClass tints its column", blue(px[12].marker) && plain(px[12].numbers), JSON.stringify(px))
	check("gutter: lineNumberMarkers' classes tint the number column", green(px[14].numbers) && plain(px[14].marker), JSON.stringify(px))
	check("gutter: other lines aren't tinted", plain(px[16].marker) && plain(px[16].numbers), JSON.stringify(px))

	// Widgets: equal ones reuse their label, updateDOM updates the DOM in
	// place (inline and block), and widget DOM is live.
	let wd = await page.evaluate(async () => {
		let frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let {StateEffect, StateField, Decoration, WidgetType, EditorView} = cmApi
		let made = 0
		class Tag extends WidgetType {
			constructor(label, block) { super(); this.label = label; this.block = block }
			eq(o) { return o.label == this.label }
			updateDOM(dom) { dom.textContent = this.label; return true }
			toDOM() { made++; let el = document.createElement(this.block ? "div" : "span"); el.className = "probe-tag"; el.textContent = this.label; return el }
		}
		let setTag = StateEffect.define()
		let field = StateField.define({
			create: () => Decoration.none,
			update(v, tr) {
				for (let e of tr.effects) if (e.is(setTag)) {
					let l = tr.state.doc.line(20)
					v = Decoration.set([Decoration.widget({widget: new Tag(e.value), side: 1}).range(l.from + 2),
						Decoration.widget({widget: new Tag("B:" + e.value, true), block: true, side: 1}).range(l.to)])
				}
				return v.map(tr.changes)
			},
			provide: f => EditorView.decorations.from(f)
		})
		view.scrollTop = view.lineTop(20) - 100
		view.dispatch({effects: [StateEffect.appendConfig.of(field), setTag.of("ab")]})
		await frames()
		let pos = view.state.doc.line(20).from + 3, after = () => view.coordsAtPos(pos).left
		let inline = () => view.decos.widgetElement(view.decos.points.find(p => p.deco.spec.widget instanceof Tag && !p.block).deco.spec.widget)
		let block = () => document.querySelector("div.probe-tag")
		let el = inline(), bl = block(), x0 = after(), r = {made: made}
		view.dispatch({effects: setTag.of("ab")})
		await frames()
		r.eq = {made, same: inline() === el}
		view.dispatch({effects: setTag.of("abcdef")})
		await frames()
		r.upd = {made, same: inline() === el, blockSame: block() === bl, blockText: block().textContent, grew: Math.round((after() - x0) / view.cellWidth)}
		el.textContent = "x"
		await new Promise(r => setTimeout(r, 0))
		await frames()
		r.live = Math.round((after() - x0) / view.cellWidth)
		return r
	})
	check("widgets: an equal widget reuses the label (no toDOM)", wd.made == 2 && wd.eq.made == 2 && wd.eq.same, JSON.stringify(wd))
	check("widgets: updateDOM updates an inline widget in place", wd.upd.made == 2 && wd.upd.same && wd.upd.grew == 4, JSON.stringify(wd))
	check("widgets: updateDOM updates a block widget in place", wd.upd.blockSame && wd.upd.blockText == "B:abcdef", JSON.stringify(wd))
	check("widgets: a widget's DOM is live (changes are drawn)", wd.live == -1, JSON.stringify(wd))

	// Read-only keeps selection but ignores typing and hides the keyboard.
	let ro = await page.evaluate(async () => {
		view.dispatch({effects: cmApi.StateEffect.appendConfig.of(view.state.facet ? [] : [])})
		return null
	})
	void ro
	check("options: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}
{
	let t = await open("kind=js&lines=200&ext=basic&readOnly=1")
	let {page} = t
	await page.evaluate(() => { view.dispatch({selection: {anchor: 10}}); view.focus() })
	let docBefore = await page.evaluate(() => view.state.doc.length)
	await page.keyboard.type("abc")
	await t.frames()
	let ro = await page.evaluate(() => ({len: view.state.doc.length, mode: view.contentDOM.inputMode, focused: view.hasFocus}))
	check("read-only: typing doesn't change the document", ro.len == docBefore, JSON.stringify(ro))
	check("read-only: no on-screen keyboard (inputmode none)", ro.mode == "none", JSON.stringify(ro))
	let ne = await page.evaluate(() => {
		view.dispatch({effects: cmApi.StateEffect.appendConfig.of(cmApi.EditorView.editable.of(false))})
		view.focus()
		return {focused: view.hasFocus, editable: view.editable}
	})
	check("editable false: the editor can't be focused", !ne.focused && !ne.editable, JSON.stringify(ne))
	await page.close()
}
{
	let t = await open("kind=empty&lines=200")
	check("placeholder: drawn while the document is empty", await t.page.evaluate(() => view.placeholderGlyphs.count > 10))
	await t.page.close()
}

// Fold markers fade in and out ("fade" mode) instead of switching.
{
	let t = await open("kind=js&lines=2000&ext=basic")
	let {page} = t
	// Alpha of each frame's fold markers (glyphs right of the line numbers).
	let alphas = (n, setup) => page.evaluate(async (n, setup) => {
		let read = () => {
			let b = view.dynGlyphs, out = []
			for (let i = 0; i < b.count; i++) {
				let x = b.f32[i * b.stride]
				if (x >= view.gutterRight && x < view.gutterWidth) out.push(b.u32[i * b.stride + 4] >>> 24)
			}
			return out
		}
		if (setup == "in") view.dispatch({selection: {anchor: view.state.doc.line(12).from + 2}})
		else view.dispatch({selection: {anchor: 0}})
		let seen = []
		for (let i = 0; i < n; i++) {
			await new Promise(r => requestAnimationFrame(r))
			seen.push(Math.max(0, ...read()))
		}
		return {seen, fading: view.foldFading}
	}, n, setup)
	await page.evaluate(() => view.dispatch({selection: {anchor: 0}}))
	await t.frames()
	let fadeIn = await alphas(20, "in")
	let mid = fadeIn.seen.some(a => a > 0 && a < 200), last = fadeIn.seen[fadeIn.seen.length - 1]
	let rising = fadeIn.seen.every((a, i) => i == 0 || a >= fadeIn.seen[i - 1])
	check("fold markers: the cursor's marker fades in", mid && rising && last > 200 && !fadeIn.fading, JSON.stringify(fadeIn))
	let fadeOut = await alphas(20, "out")
	let falling = fadeOut.seen.every((a, i) => i == 0 || a <= fadeOut.seen[i - 1])
	check("fold markers: and fades out when the cursor leaves", falling && fadeOut.seen.some(a => a > 0 && a < 200) &&
		fadeOut.seen[fadeOut.seen.length - 1] == 0 && !fadeOut.fading, JSON.stringify(fadeOut))
	// Quickly hovering the gutter and leaving it reverses the fade at a
	// low alpha. A marker whose tint rounds to alpha 0 must not be drawn:
	// a zero tint marks a color glyph, so the shader drew the mask itself
	// (a white flash on dark themes).
	let flash = await page.evaluate(async () => {
		let r = view.scrollDOM.getBoundingClientRect(), frames = 0, zero = 0
		let move = x => view.scrollDOM.dispatchEvent(new PointerEvent("pointermove",
			{clientX: r.left + x, clientY: r.top + 200, pointerType: "mouse", bubbles: true}))
		let watch = true
		let loop = () => {
			if (!watch) return
			frames++
			let b = view.dynGlyphs
			for (let i = 0; i < b.count; i++) {
				let x = b.f32[i * b.stride], c = b.u32[i * b.stride + 4]
				if (x >= view.gutterRight && x < view.gutterWidth && c && !(c >>> 24)) zero++
			}
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
		for (let k = 0; k < 8; k++) {
			move(view.gutterLeft + 5)
			await new Promise(r => setTimeout(r, 15 + k * 10))
			move(view.gutterWidth + 60)
			await new Promise(r => setTimeout(r, 180))
		}
		watch = false
		return {frames, zero}
	})
	check("fold markers: quick hovers never draw a marker with a zero tint", flash.frames > 20 && flash.zero == 0, JSON.stringify(flash))
	check("fold markers: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// Zero-width diagnostics (CodeMirror's lint points) draw a small
// triangle; toCanvas widgets get DOM only when tapped.
{
	let t = await open("kind=js&lines=200&ext=basic")
	let {page} = t
	// Share of the point's color in a box under the position.
	let pointPixels = (pos, rgb) => page.evaluate(async (pos, rgb) => {
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let c = view.coordsAtPos(pos)
		window.__clip = {x: c.left - 4, y: c.bottom - 5, width: 8, height: 5}
		return window.__clip
	}, pos, rgb).then(async clip => {
		let png = await page.screenshot({clip, encoding: "base64"})
		return page.evaluate(async (png, rgb) => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data, n = 0
			for (let i = 0; i < d.length; i += 4)
				if (Math.abs(d[i] - rgb[0]) < 40 && Math.abs(d[i + 1] - rgb[1]) < 40 && Math.abs(d[i + 2] - rgb[2]) < 40) n++
			return n / (d.length / 4)
		}, png, rgb)
	})
	let at = await page.evaluate(() => [view.state.doc.line(3).from + 6, view.state.doc.line(5).from + 4])
	let red = [221, 17, 17], orange = [255, 165, 0]
	let before = await pointPixels(at[0], red)
	await page.evaluate(at => view.dispatch(cmApi.setDiagnostics(view.state, [
		{from: at[0], to: at[0], severity: "error", message: "missing"},
		{from: at[1], to: at[1], severity: "warning", message: "careful"}])), at)
	let error = await pointPixels(at[0], red), warning = await pointPixels(at[1], orange)
	check("lint points: a zero-width error draws a red triangle", before < 0.02 && error > 0.15, JSON.stringify({before, error}))
	check("lint points: a warning's is orange", warning > 0.15, String(warning))
	check("lint points: they take no room", await page.evaluate(at => {
		let a = view.coordsAtPos(at[0]), b = view.coordsAtPos(at[0] + 1)
		return Math.abs(b.left - a.left - view.cellWidth) < 0.5
	}, at))

	let lazy = await page.evaluate(async () => {
		let {Decoration, WidgetType, StateEffect, StateField, EditorView} = cmApi
		window.made = 0
		window.clicked = null
		class Chip extends WidgetType {
			eq() { return true }
			toCanvas() { return {text: "", cells: 1, style: {background: "#e5c07b", rounded: true}} }
			toDOM() { window.made++; let s = document.createElement("span"); s.className = "lazy-chip"; return s }
		}
		let pos = view.state.doc.line(7).from + 2
		let field = StateField.define({create: () => Decoration.set([Decoration.widget({widget: new Chip(), side: -1}).range(pos)]),
			update: (d, tr) => d.map(tr.changes), provide: f => EditorView.decorations.from(f)})
		view.dispatch({effects: StateEffect.appendConfig.of([field, EditorView.domEventHandlers({
			click(e) { if (e.target.className == "lazy-chip") { window.clicked = "lazy-chip"; return true } return false }})])})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let c = view.coordsAtPos(pos)
		return {made: window.made, x: c.left - view.cellWidth / 2, y: (c.top + c.bottom) / 2}
	})
	await t.tap(lazy.x, lazy.y)
	let after = await page.evaluate(() => ({made: window.made, clicked: window.clicked}))
	check("toCanvas widgets: no DOM until tapped", lazy.made == 0, JSON.stringify(lazy))
	check("toCanvas widgets: a tap makes it and reaches click handlers", after.made == 1 && after.clicked == "lazy-chip", JSON.stringify(after))
	check("lint points: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Tab stops after widgets, folds, block replaces, on wrapped rows --------------
{
	// The same document and decorations in CodeMirror (cm.html) and the
	// canvas view: tabs stop at screen columns, like the browser lays
	// out CodeMirror's lines.
	let scenario = async () => {
		let canvas = !!window.view, v = canvas ? window.view : window.cm
		let {Decoration, WidgetType, StateEffect, StateField, EditorView} = canvas ? window.cmApi : window.cmLib
		class W extends WidgetType {
			constructor(t, w, block) { super(); this.t = t; this.w = w; this.block = block }
			eq(o) { return o.t == this.t && o.w == this.w }
			get estimatedHeight() { return this.block ? 20 : -1 }
			toDOM() {
				let s = document.createElement(this.block ? "div" : "span")
				s.textContent = this.t
				if (this.w != null) { s.style.display = "inline-block"; s.style.width = this.w }
				if (this.block) s.style.height = "20px"
				return s
			}
		}
		let set = StateEffect.define()
		let field = StateField.define({create: () => Decoration.none,
			update: (d, tr) => { for (let e of tr.effects) if (e.is(set)) return e.value; return d.map(tr.changes) },
			provide: f => EditorView.decorations.from(f)})
		v.dispatch({effects: StateEffect.appendConfig.of(field)})
		v.dispatch({changes: {from: 0, to: v.state.doc.length,
			insert: ["ab\tc", "ab\tc", "ab\tc", "x\ty", "ab\tc", "q", "end\tz", "\tA\tB", "界\tc"].join("\n")}})
		let L = n => v.state.doc.line(n)
		v.dispatch({effects: set.of(Decoration.set([
			Decoration.widget({widget: new W("xyz"), side: -1}).range(L(1).from + 2),
			Decoration.widget({widget: new W("", "1.9ch"), side: 1}).range(L(2).from + 2),
			Decoration.widget({widget: new W("", "1.4ch"), side: 1}).range(L(3).from + 2),
			Decoration.replace({widget: new W("BLOCK", null, true), block: true}).range(L(4).from + 1, L(5).from + 2),
			Decoration.replace({widget: new W("…")}).range(L(6).from + 1, L(7).from + 1)
		], true))})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let cw = v.defaultCharacterWidth, x0 = v.coordsAtPos(L(8).from, 1).left
		let col = pos => Math.round((v.coordsAtPos(pos, 1).left - x0) / cw * 10) / 10
		// Line 9: a wide glyph's real advance, then a tab: the tab ends
		// at a stop at least half a cell away (measured on both pages).
		let wide = col(L(9).from + 1)
		return {
			"after an inline widget": col(L(1).from + 3),
			"less than half a cell before a stop": col(L(2).from + 3),
			"more than half a cell before a stop": col(L(3).from + 3),
			"after a block replace inside a line": col(L(5).from + 3),
			"after a fold placeholder": col(L(7).from + 4),
			"plain line": col(L(8).from + 3),
			"after a wide glyph": Math.round((col(L(9).from + 2) - wide) * 10) / 10 >= 0.5 && col(L(9).from + 2) % 4 == 0
		}
	}
	let cmPage = await browser.newPage()
	await cmPage.setViewport({width: 412, height: 860, deviceScaleFactor: 2.625})
	await cmPage.goto(`http://localhost:${port}/cm.html?lines=20`)
	await cmPage.waitForFunction("window.ready === true")
	let want = await cmPage.evaluate(scenario)
	await cmPage.close()
	let t = await open("lines=20")
	let {page} = t
	let got = await page.evaluate(scenario)
	for (let name of Object.keys(want))
		check(`tabs: ${name} stops like CodeMirror`, got[name] === want[name], JSON.stringify({got: got[name], want: want[name]}))

	// A tap just past the tab after the widget lands after it, and the
	// cursor there is drawn at the tab stop.
	let geo = await page.evaluate(() => {
		let l = view.state.doc.line(1), c = view.coordsAtPos(l.from + 3, 1)
		return {from: l.from, x: c.left, top: c.top, bottom: c.bottom, cw: view.defaultCharacterWidth}
	})
	await t.tap(geo.x + geo.cw * 0.2, (geo.top + geo.bottom) / 2)
	let s = await t.sel()
	check("tabs: a tap after a tab past a widget lands after it", s.head == geo.from + 3, JSON.stringify({s, geo}))
	let drawn = await t.drawnCursorX(geo.x, geo.top, geo.bottom)
	check("tabs: the cursor after it is drawn at the tab stop", drawn != null && Math.abs(drawn - geo.x) < 1.5, `drawn ${drawn} expected ${geo.x}`)
	await t.key("ArrowLeft")
	let left = await page.evaluate(() => view.coordsAtPos(view.state.selection.main.head, 1).left)
	check("tabs: ArrowLeft goes before the tab, where the widget ends", (await t.sel()).head == geo.from + 2 &&
		Math.abs(left - (geo.x - 3 * geo.cw)) < 1, JSON.stringify({left, x: geo.x}))

	// Wrapped rows: tabs on a continuation row stop at that row's tab
	// stops (CodeMirror measures from the row's start), not the
	// unwrapped line's.
	let w = await page.evaluate(async () => {
		view.reconfigure({lineWrapping: true, wrapIndent: "none"})
		let words = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp "
		let text = words + "i\tj\tk", from = view.state.doc.length + 1
		view.dispatch({changes: {from: from - 1, insert: "\n" + text}})
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let cw = view.defaultCharacterWidth, x0 = view.coordsAtPos(view.state.doc.line(8).from, 1).left
		let tab = from + text.indexOf("\t")
		let c = pos => { let r = view.coordsAtPos(pos, 1); return {x: Math.round((r.left - x0) / cw * 10) / 10, top: Math.round(r.top)} }
		let row0 = c(from).top, i = c(tab - 1), j = c(tab + 1), k = c(tab + 3)
		let back = view.posAtCoords({x: x0 + (j.x + 0.2) * cw, y: j.top + 3}) - tab
		return {wrapped: i.top != row0, unwrappedJ: text.indexOf("\t") + (4 - text.indexOf("\t") % 4), i, j, k, back}
	})
	check("tabs: wrapped rows stop tabs at the row's tab stops", w.wrapped && w.j.x % 4 == 0 && w.k.x == w.j.x + 4 &&
		w.j.x - w.i.x - 1 >= 0.5 && w.j.x - w.i.x <= 5, JSON.stringify(w))
	check("tabs: a tap after a tab on a wrapped row lands after it", w.back == 1, JSON.stringify(w))
	check("tabs: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Syntax colors from the state's highlighters ---------------------------------
{
	let t = await open("kind=js&lines=200&ext=basic")
	let {page} = t
	// The canvas color for keywords, by the class the state's highlighters give them.
	let keywordColor = () => page.evaluate(async () => {
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let cls = cmApi.highlightingFor(view.state, [cmApi.tags.definitionKeyword])
		let classes = view.syntax.classes, id = classes.findIndex(c => cls ? c.split(" ").includes(cls.split(" ")[0]) : c == "0")
		if (id < 0) return null
		let packed = view.styles[view.styleForClass(id)].color
		return [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255]
	})
	let themed = await keywordColor()
	await page.evaluate(() => view.dispatch({effects: cmApi.StateEffect.appendConfig.of(
		cmApi.syntaxHighlighting(cmApi.HighlightStyle.define([{tag: cmApi.tags.keyword, color: "#ff0000"}])))}))
	let fromStyle = await keywordColor()
	check("highlight style in the state colors tokens", fromStyle?.join() == "255,0,0", JSON.stringify({themed, fromStyle}))
	// Class-based highlighters get their colors from CSS (here an editor theme).
	await page.evaluate(() => view.setState(cmApi.EditorState.create({doc: view.state.doc, extensions: [
		cmApi.javascript(), cmApi.syntaxHighlighting(cmApi.classHighlighter),
		cmApi.EditorView.theme({".tok-keyword": {color: "rgb(0, 200, 0)"}})]})))
	let fromCSS = await keywordColor()
	check("class highlighter tokens take their CSS color", fromCSS?.join() == "0,200,0", JSON.stringify(fromCSS))
	check("highlighters: no errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Line height from the CSS, like CodeMirror -----------------------------------
{
	let t = await open("lines=20")
	let {page} = t
	let lh = await page.evaluate(async () => {
		let CanvasView = view.constructor, {EditorView, EditorState, StateEffect} = cmApi
		let wait = () => new Promise(r => setTimeout(r, 100))
		// Acode's font theme: a line height on the editor, which
		// CodeMirror's scroller line height (1.4) overrides.
		let theme = EditorView.theme({"&": {fontSize: "12px", lineHeight: "2"}})
		let box = () => {
			let d = document.body.appendChild(document.createElement("div"))
			d.style.cssText = "position:fixed;left:0;top:0;width:300px;height:200px"
			return d
		}
		let doc = Array.from({length: 400}, (_, i) => "line " + i).join("\n")
		let ev = new EditorView({doc, parent: box(), extensions: [theme]})
		let cv = new CanvasView({state: EditorState.create({doc, extensions: [theme]}), parent: box(), font: {size: 12}})
		await wait()
		let domLine = () => ev.contentDOM.querySelector(".cm-line").getBoundingClientRect().height
		let r = {dom: domLine(), canvas: cv.lineHeight,
			rowStep: cv.coordsAtPos(cv.state.doc.line(3).from).top - cv.coordsAtPos(cv.state.doc.line(2).from).top}
		// A far line: CodeMirror measures it once it's on screen.
		let far = ev.state.doc.line(400).from
		ev.dispatch({effects: EditorView.scrollIntoView(far, {y: "start"})})
		await wait(); await wait()
		r.domFar = ev.lineBlockAt(far).top
		r.canvasFar = cv.lineBlockAt(far).top
		let t2 = EditorView.theme({".cm-content": {lineHeight: "1.8"}})
		ev.dispatch({effects: StateEffect.appendConfig.of(t2)})
		cv.dispatch({effects: StateEffect.appendConfig.of(t2)})
		await wait()
		r.domThemed = domLine()
		r.canvasThemed = cv.lineHeight
		cv.setFont({lineHeight: 1.5})
		r.fixed = cv.lineHeight
		cv.setFont({lineHeight: undefined})
		r.unset = cv.lineHeight
		ev.destroy(); cv.destroy()
		// Created before it's in the document: read once connected.
		let late = new CanvasView({doc: "x", font: {size: 12}, extensions: [EditorView.theme({".cm-scroller": {lineHeight: "1.8"}})]})
		r.lateBefore = late.lineHeight
		box().appendChild(late.dom)
		await wait()
		r.lateAfter = late.lineHeight
		late.destroy()
		return r
	})
	// Measured like CodeMirror's, so exactly the DOM's (1/64 px units).
	let near = (a, b) => Math.abs(a - b) < 1e-6
	check("line height: CodeMirror's scroller line height, not the editor's", near(lh.canvas, lh.dom) && near(lh.rowStep, lh.dom), JSON.stringify(lh))
	check("line height: no drift from the DOM editor's lines", near(lh.canvasFar, lh.domFar), JSON.stringify(lh))
	check("line height: follows a theme reconfiguration", near(lh.canvasThemed, lh.domThemed) && lh.domThemed > lh.dom + 3, JSON.stringify(lh))
	check("line height: a configured one wins, unsetting it follows the CSS again", near(lh.fixed, 18) && near(lh.unset, lh.domThemed), JSON.stringify(lh))
	check("line height: read once the view is in the document", Math.abs(lh.lateAfter - 21.6) < 0.02, JSON.stringify(lh))
	check("line height: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- Scroll options ----------------------------------------------------------------
{
	let t = await open("kind=js&lines=20000&ext=basic")
	let {page, cdp} = t
	let past = await page.evaluate(() => {
		let full = view.maxScrollTop
		view.reconfigure({scrollPastEnd: 0.5})
		let half = view.maxScrollTop
		view.reconfigure({scrollPastEnd: false})
		let none = view.maxScrollTop
		return {full, half, none, room: view.height - view.lineHeight - 4}
	})
	check("scrollPastEnd: fractions of the view height", Math.abs(past.full - past.half - past.room / 2) < 2 &&
		Math.abs(past.half - past.none - past.room / 2) < 5, JSON.stringify(past))

	let flingDistance = async speed => {
		await page.evaluate(speed => { view.reconfigure({scrollSpeed: speed}); view.scrollTop = 20000 }, speed)
		await t.frames()
		let start = await page.evaluate(() => view.scrollTop)
		await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 206, y: 600, id: 1}]})
		for (let k = 1; k <= 10; k++) {
			await sleep(8)
			await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 206, y: 600 - 30 * k, id: 1}]})
		}
		await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
		await page.waitForFunction("!view.scrolling", {timeout: 10000})
		return page.evaluate(start => view.scrollTop - start, start)
	}
	// Swipe timing jitters: compare medians of three.
	let median = async speed => {
		let d = [await flingDistance(speed), await flingDistance(speed), await flingDistance(speed)].sort((a, b) => a - b)
		return d[1]
	}
	// An app's scrollbar setting scrollTop mid-fling stops the fling there.
	let grabbed = await page.evaluate(async () => {
		let frame = () => new Promise(r => requestAnimationFrame(r))
		view.scrollTop = view.lineTop(2000)
		await frame()
		view.fling(0, 8000)
		await frame(); await frame()
		let wasFlinging = view.scrolling
		view.scrollDOM.scrollTop = 1000
		for (let i = 0; i < 10; i++) await frame()
		return {wasFlinging, top: view.scrollTop, scrolling: view.scrolling}
	})
	check("scrollTop set during a fling stops it there", grabbed.wasFlinging && grabbed.top == 1000 && !grabbed.scrolling, JSON.stringify(grabbed))
	let normal = await median("normal"), fast = await median("fastX2"), slow = await median("slow")
	check("scrollSpeed: fast flings farther, slow shorter", fast > normal * 1.5 && slow < normal * 0.8, JSON.stringify({slow, normal, fast}))
	await page.close()
}

// ---- The state's syntax tree follows the driver's ------------------------------

// `syntaxTree(state)` users (folding, bracket matching, autocomplete,
// indentation) read the state's tree, which the view shares from its
// syntax driver. On screen, it mustn't lag the driver's parse.
{
	let t = await open("kind=js&lines=60000"), page = t.page
	// Visible text first covered by the driver's tree, then by the state's.
	let coverDelay = () => page.evaluate(() => new Promise(resolve => {
		let doc = view.state.doc, t0 = performance.now(), driverAt = -1
		let poll = () => {
			let end = Math.min(doc.length, view.syntax.visibleEnd), pub = view.syntax.canonicalTree(doc)
			let now = performance.now()
			if (driverAt < 0 && pub && pub.len >= end) driverAt = now
			if (driverAt >= 0 && cmApi.syntaxTree(view.state).length >= end) return resolve({delay: now - driverAt, end})
			if (now - t0 > 10000) return resolve({delay: -1, end, driver: pub?.len, state: cmApi.syntaxTree(view.state).length})
			setTimeout(poll, 1)
		}
		poll()
	}))
	// While the user scrolls or types, sharing waits (each share is a
	// transaction every plugin sees), but input acts on the full tree: a
	// key or tap arriving first shares it before it's handled. Jump just
	// past the parsed text while "interacting", wait for the driver to
	// cover the screen, then send the input; a capturing listener on the
	// window (it runs before the editor's) records whether the state was
	// still behind then. Attempts where the 250ms share came first don't
	// count.
	let prepare = type => page.evaluate(async type => {
		let doc = view.state.doc, pub = view.syntax.canonicalTree(doc)
		let n = doc.lineAt(Math.min(doc.length - 1, (pub ? pub.len : 0) + 15000)).number
		view.noteInput(performance.now())
		view.scrollTop = view.lineTop(n) - view.height / 3
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		let end = 0
		for (let i = 0; i < 3000; i++) {
			view.noteInput(performance.now())
			pub = view.syntax.canonicalTree(doc)
			end = Math.min(doc.length, view.syntax.visibleEnd)
			if (pub && pub.len >= end) break
			await new Promise(r => setTimeout(r, 2))
		}
		while (!/\{\s*$/.test(doc.line(n).text)) n++
		window.__behindAtInput = null
		window.addEventListener(type, () => { window.__behindAtInput = cmApi.syntaxTree(view.state).length < end }, {capture: true, once: true})
		let c = view.coordsAtPos(doc.line(n).from), box = view.scrollDOM.getBoundingClientRect()
		return {n, end, driverCovers: !!pub && pub.len >= end, x: box.left + view.gutterWidth / 2, y: (c.top + c.bottom) / 2}
	}, type)
	let inputResult = async (type, act) => {
		for (let attempt = 0; attempt < 4; attempt++) {
			let p = await prepare(type)
			await act(p)
			let r = await page.evaluate((n, end) => ({behind: window.__behindAtInput, state: cmApi.syntaxTree(view.state).length,
				folded: view.lines.hidden(n + 1), covered: cmApi.syntaxTree(view.state).length >= end}), p.n, p.end)
			if (p.driverCovers && r.behind) return {...p, ...r, attempt}
		}
		return null
	}
	await page.evaluate(() => view.focus())
	let byKey = await inputResult("keydown", () => page.keyboard.press("ArrowRight"))
	check("tree sync: a key arriving first shares the tree", byKey?.covered, JSON.stringify(byKey))
	let byTap = await inputResult("pointerdown", p => t.tap(p.x, p.y))
	check("tree sync: tapping a line number folds a block that just scrolled in", byTap?.covered && byTap.folded, JSON.stringify(byTap))
	await sleep(1200)

	// Without input, it follows as soon as the driver covers the screen
	// (worst of several jumps, each past what the background parse covered).
	let delays = []
	for (let line of [28000, 42000, 56000]) {
		await page.evaluate(n => { view.scrollTop = view.lineTop(n) }, line)
		delays.push(await coverDelay())
		await sleep(1200)
	}
	let worst = Math.max(...delays.map(d => d.delay < 0 ? Infinity : d.delay))
	check("tree sync: the state's tree covers the screen right after the driver's", worst < 60, JSON.stringify(delays))

	await page.close()
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
