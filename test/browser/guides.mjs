// Browser tests for bracket pair guides (`bracketPairGuides`): which
// pairs are drawn and where, the active pair, drawn pixels, updates on
// edits, and that cursor moves and scrolling don't recompute them.
//
//   node test/browser/guides.mjs [--backend=webgl2|webgpu]

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
await page.goto(`${server.url}/index.html?kind=js&lines=200&backend=${backend}&bare=1&ext=basic&blink=0`)
await page.waitForFunction("window.ready === true")
await sleep(300)
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

const CODE = [
	"function f(a) {",
	"    if (a) {",
	"        g([",
	"            1,",
	"        ])",
	"    }",
	"    let s = \"{ ( [\"",
	"    // } ) ]",
	"    return h(a, b)",
	"}",
	""
].join("\n")
/// Drawn guides: x (in cells), first row, rows, alpha.
const guides = () => page.evaluate(() => {
	let b = view.pairRects, out = []
	for (let i = 0; i < b.count; i++) {
		let at = i * 5
		out.push({col: Math.round(b.f32[at] / view.cellWidth), row: Math.round(b.f32[at + 1] / view.lineHeight) + view.scene.origin,
			rows: Math.round(b.f32[at + 3] / view.lineHeight), w: b.f32[at + 2], a: b.u32[at + 4] >>> 24})
	}
	return out.sort((x, y) => x.col - y.col)
})
async function setDoc(doc, line = 1) {
	await page.evaluate((doc, line) => {
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: doc}})
		view.dispatch({selection: {anchor: view.state.doc.line(line).from}})
		view.scrollTop = 0
		view.focus()
	}, doc, line)
	await sleep(200)
	await frames()
}

await setDoc(CODE, 4)
check("off by default", (await guides()).length == 0)

await page.evaluate(() => view.reconfigure({bracketPairGuides: true}))
await frames()
let g = await guides()
// The function's pair at column 0 (rows 1-8), the if's at 4 (rows 2-4),
// the inner `[` at 8 (row 3); its `(` on the same line and column isn't
// drawn twice. Brackets in the string and comment, and the same-line
// `h(a, b)`, aren't pairs.
check("one guide per pair spanning lines, at the right columns and rows",
	JSON.stringify(g.map(x => [x.col, x.row, x.rows])) == JSON.stringify([[0, 1, 8], [4, 2, 3], [8, 3, 1]]), JSON.stringify(g))
check("guides are 1px wide", g.every(x => x.w == 1), JSON.stringify(g))
check("the cursor's pair is drawn in full, the others faded", g[2].a == 255 && g[0].a < 140 && g[1].a < 140, JSON.stringify(g.map(x => x.a)))

// Drawn: a pixel of the column-0 guide on line 7 isn't the background.
{
	await frames()
	let at = await page.evaluate(() => {
		let c = view.coordsAtPos(view.state.doc.line(7).from)
		return {x: c.left, y: (c.top + c.bottom) / 2, x2: c.left + view.cellWidth * 2}
	})
	let png = await page.screenshot({clip: {x: at.x - 1, y: at.y - 1, width: 3, height: 2}, encoding: "base64"})
	let png2 = await page.screenshot({clip: {x: at.x2, y: at.y - 1, width: 2, height: 2}, encoding: "base64"})
	let px = await page.evaluate(async (a, b) => {
		let read = async src => {
			let img = new Image()
			img.src = "data:image/png;base64," + src
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data, max = 0
			for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] + d[i + 1] + d[i + 2])
			return max
		}
		return {guide: await read(a), blank: await read(b)}
	}, png, png2)
	check("the guide is drawn on the canvas", px.guide > px.blank + 40, JSON.stringify(px))
}

// Moving the cursor only changes which pair is active: the pairs and
// their spans are kept, nothing is rescanned or re-emitted.
{
	await page.evaluate(() => { window.pairsBefore = view.bracketPairs(); view.stats.length = 0; view.recordStats = true })
	await page.keyboard.press("ArrowUp")
	await page.keyboard.press("ArrowUp")
	await frames()
	let same = await page.evaluate(() => view.bracketPairs() === window.pairsBefore)
	let st = await page.evaluate(() => { view.recordStats = false; return view.stats.map(s => s.rebuilt) })
	g = await guides()
	check("a cursor move keeps the pairs", same)
	check("a cursor move rebuilds no scene", st.every(r => !r), JSON.stringify(st))
	check("the active pair follows the cursor (line 2: the function's)", g[0].a == 255 && g[1].a < 140 && g[2].a < 140, JSON.stringify(g.map(x => x.a)))
}

// Edits update them.
await page.evaluate(() => {
	let l = view.state.doc.line(4)
	view.dispatch({changes: {from: l.to, insert: "\n            2,\n            3,"}})
})
await sleep(100)
await frames()
g = await guides()
check("an edit inside a pair lengthens its guides", JSON.stringify(g.map(x => [x.col, x.rows])) == JSON.stringify([[0, 10], [4, 5], [8, 3]]), JSON.stringify(g))

// "active" mode draws the cursor's pair only.
await page.evaluate(() => { view.reconfigure({bracketPairGuides: "active"}); view.dispatch({selection: {anchor: view.state.doc.line(4).from}}) })
await frames()
g = await guides()
check("\"active\": only the cursor's pair", g.length == 1 && g[0].col == 8 && g[0].a == 255, JSON.stringify(g))
await page.evaluate(() => view.reconfigure({bracketPairGuides: true}))

// A line whose text starts at or left of the guide breaks it: guides
// never cross text.
await setDoc(["foo(", "    a,", "b,", "    c", ")", ""].join("\n"), 1)
g = await guides()
check("a guide stops at text starting left of it", JSON.stringify(g.map(x => [x.col, x.row, x.rows])) == JSON.stringify([[0, 1, 1], [0, 3, 1]]) ||
	JSON.stringify(g.map(x => [x.col, x.row, x.rows]).sort()) == JSON.stringify([[0, 1, 1], [0, 3, 1]]), JSON.stringify(g))

// Folds: a folded pair has no guide, and the guides around it skip its rows.
await setDoc(CODE, 1)
let folded = await page.evaluate(() => {
	view.dispatch({effects: window.cmApi.StateEffect.appendConfig.of(window.cmApi.codeFolding())})
	let ranges = window.cmApi.foldable(view.state, view.state.doc.line(2).from, view.state.doc.line(2).to)
	if (!ranges) return false
	view.dispatch({effects: window.cmApi.foldEffect.of(ranges)})
	return true
})
if (folded) {
	await frames()
	g = await guides()
	check("folding: the folded pair's guides go, the function's spans the folded rows' place",
		g.length == 1 && g[0].col == 0 && g[0].rows == 4, JSON.stringify(g))
}

// Long documents: the pairs of the window only, and a fling doesn't
// recompute them within a window.
await page.goto(`${server.url}/index.html?kind=deep&lines=3000&backend=${backend}&bare=1&ext=basic&blink=0&pairGuides=1`)
await page.waitForFunction("window.ready === true")
await sleep(500)
{
	let n = await page.evaluate(async () => {
		view.scrollTop = view.lineTop(1500)
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
		return {pairs: view.bracketPairs().length, rects: view.pairRects.count}
	})
	check("deep nesting far down: pairs opened above the window are found", n.pairs > 10 && n.rects > 10, JSON.stringify(n))
	let computes = await page.evaluate(async () => {
		view.stats.length = 0
		view.recordStats = true
		view.fling(0, 2500)
		await new Promise(r => setTimeout(r, 1200))
		view.recordStats = false
		return view.stats.filter(s => s.dynMs > 0.5).length
	})
	check("flinging: guide work only when the window moves", computes < 15, String(computes))
}

await page.close()
await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
