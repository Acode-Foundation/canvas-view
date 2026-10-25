// Browser test for font ligatures: runs of punctuation shaped as a
// whole with a ligature font (Fira Code, as shipped with Acode),
// nothing changed with a font without them, the option and the CSS
// switches (like CodeMirror's DOM text), ligatures cut by color, tab
// lines, wrapping, and the cursor inside a ligature. Run after
// `bun run demo:build`:
//
//   node test/browser/ligatures.mjs [--backend=webgl2|webgpu] [--browser=path]

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
const browserPath = args.browser ?? process.env.CHROME_PATH ?? join(homedir(),
	"Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
const root = resolve(import.meta.dirname, "../../demo-dist")

const server = createServer(async (req, res) => {
	let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
	try {
		let body = await readFile(path)
		res.writeHead(200, {"content-type": {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf"}[extname(path)] ?? "application/octet-stream"})
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
	await page.goto(`http://localhost:${port}/index.html?backend=${backend}&bare=1&kind=js&lines=20&rainbow=0&${query}`)
	await page.waitForFunction("window.ready === true")
	await page.evaluate(() => document.fonts.ready)
	await sleep(300)
	let frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
	// Replace the document (the cursor parked at its end, blurred) and
	// return a screenshot of line `n`'s first `cols` columns.
	let setDoc = async doc => {
		await page.evaluate(doc => {
			view.contentDOM.blur()
			view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: doc}, selection: {anchor: doc.length}})
			view.scrollDOM.scrollTop = 0
		}, doc)
		await sleep(50)
		await frames()
	}
	let shot = async (n, cols) => {
		await frames()
		let r = await page.evaluate((n, cols) => {
			let line = view.state.doc.line(n), a = view.coordsAtPos(line.from)
			return {x: a.left, y: a.top, w: cols * view.cellWidth, h: a.bottom - a.top}
		}, n, cols)
		return page.screenshot({clip: {x: r.x - 2, y: r.y, width: r.w + 4, height: r.h}, encoding: "base64"})
	}
	let reconfigure = async options => {
		await page.evaluate(o => view.reconfigure(o), options)
		await sleep(30)
		await frames()
	}
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
	return {page, frames, setDoc, shot, reconfigure, drawnCursorX, errors}
}

const sample = "a => b !== c && d <= e || f // g"

// ---- A ligature font ------------------------------------------------------------
{
	let t = await open("font=fira")
	let {page} = t
	await page.waitForFunction(() => view.atlas.ligaturesOf(0), {timeout: 5000}).catch(() => {})
	check("fira: the font is found to have ligatures (after it loaded)", await page.evaluate(() => view.atlas.ligaturesOf(0)))

	let shaped = await page.evaluate(() => {
		let a = view.atlas, out = {}
		for (let run of ["=>", "!==", "===", "->", "&&", "||", "<=", "//", "#[", ");", "()", "+=", "})", "=>{"])
			out[run] = a.ligature(0, run, 0, run.length) != null
		return out
	})
	check("fira: runs the font ligates are shaped", ["=>", "!==", "===", "->", "&&", "||", "<=", "//", "#[", "=>{"].every(r => shaped[r]),
		JSON.stringify(shaped))
	check("fira: runs it doesn't ligate keep per-character glyphs", [");", "()", "+=", "})"].every(r => !shaped[r]), JSON.stringify(shaped))

	await t.setDoc(sample + "\nf(); g += 1\n")
	let on = await t.shot(1, sample.length), plainOn = await t.shot(2, 11)
	await t.reconfigure({fontLigatures: false})
	let off = await t.shot(1, sample.length), plainOff = await t.shot(2, 11)
	check("fira: ligatures change the drawing", on != off)
	check("fira: text without ligatures is drawn exactly the same", plainOn == plainOff)
	check("fira: fontLigatures false turns them off", !(await page.evaluate(() => view.atlas.ligatures)))
	await t.reconfigure({fontLigatures: true})
	check("fira: and back on", await t.shot(1, sample.length) == on)

	// Like CodeMirror's DOM text, the editor's CSS turns them off.
	// (Puppeteer drops undefined properties: set it in the page.)
	await page.evaluate(() => view.reconfigure({fontLigatures: undefined}))
	let css = async spec => {
		await page.evaluate(spec => {
			let {EditorView, StateEffect} = cmApi
			let theme = spec ? EditorView.theme(spec) : []
			if (!window.ligatureCSS) {
				window.ligatureCSS = new cmApi.readOnlyCompartment.constructor()
				view.dispatch({effects: StateEffect.appendConfig.of(ligatureCSS.of(theme))})
			} else {
				view.dispatch({effects: ligatureCSS.reconfigure(theme)})
			}
		}, spec)
		await sleep(50)
		return t.shot(1, sample.length)
	}
	check("fira: font-variant-ligatures: none turns them off", await css({".cm-content": {fontVariantLigatures: "none"}}) == off)
	check("fira: so does font-feature-settings: \"calt\" 0", await css({".cm-line": {fontFeatureSettings: '"calt" 0'}}) == off)
	check("fira: they follow the CSS when it changes back", await css(null) == on)

	// Tab-indented lines take the cluster path.
	await t.setDoc("\tx => y !== z\n")
	let tabOn = await t.shot(1, 14)
	await t.reconfigure({fontLigatures: false})
	check("fira: ligatures on tab-indented lines", tabOn != await t.shot(1, 14))
	await t.reconfigure({fontLigatures: true})

	// A ligature spanning tokens of different colors is cut at the
	// character boundary, like the browser paints it.
	await t.reconfigure({rainbowBrackets: true})
	await t.setDoc("f(()=>1)\n")
	let colors = await page.evaluate(async () => {
		let line = view.state.doc.line(1), cw = view.cellWidth
		let a = view.coordsAtPos(line.from + 2), b = view.coordsAtPos(line.from + 4)
		return {paren: {x: a.left, y: a.top, w: cw * 2, h: a.bottom - a.top}, arrow: {x: b.left, y: b.top, w: cw * 2, h: b.bottom - b.top},
			shaped: view.atlas.ligature(0, "()=>", 0, 4) != null}
	})
	let dominant = async r => {
		let png = await page.screenshot({clip: {x: r.x + 1, y: r.y, width: r.w - 2, height: r.h}, encoding: "base64"})
		return page.evaluate(async png => {
			let img = new Image()
			img.src = "data:image/png;base64," + png
			await img.decode()
			let c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			let cx = c.getContext("2d")
			cx.drawImage(img, 0, 0)
			let d = cx.getImageData(0, 0, c.width, c.height).data, best = [0, 0, 0], max = -1
			for (let i = 0; i < d.length; i += 4) {
				let sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])
				if (sat > max) { max = sat; best = [d[i], d[i + 1], d[i + 2]] }
			}
			return best
		}, png)
	}
	let paren = await dominant(colors.paren), arrow = await dominant(colors.arrow)
	let distance = Math.abs(paren[0] - arrow[0]) + Math.abs(paren[1] - arrow[1]) + Math.abs(paren[2] - arrow[2])
	check("fira: a run across tokens is shaped as a whole", colors.shaped)
	check("fira: and each part keeps its token's color", distance > 60, JSON.stringify({paren, arrow}))
	await t.reconfigure({rainbowBrackets: false})

	// The cursor inside a ligature is at the character boundary, as in
	// CodeMirror and VS Code.
	await t.setDoc("x !== y\n")
	let c = await page.evaluate(() => {
		view.focus()
		view.dispatch({selection: {anchor: 4}})
		let r = view.coordsAtPos(4), cw = view.cellWidth, left = view.coordsAtPos(0).left
		return {x: r.left, top: r.top, bottom: r.bottom, expected: left + 4 * cw}
	})
	await sleep(50)
	let x = await t.drawnCursorX(c.x, c.top, c.bottom)
	check("fira: cursor inside a ligature is at the character boundary", x != null && Math.abs(x - c.expected) < 1.5,
		JSON.stringify({x, expected: c.expected}))
	await page.evaluate(() => view.contentDOM.blur())

	// Wrapping never draws a run across rows: a banner longer than the
	// row is cut at the row's end.
	await t.reconfigure({lineWrapping: true})
	await t.setDoc("// " + "=".repeat(120) + "\nx\n")
	let rows = await page.evaluate(() => view.lines.vline(1).rows)
	check("fira: a long run wraps", rows >= 2, String(rows))
	await t.reconfigure({lineWrapping: false})

	check("fira: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

// ---- A font without ligatures ------------------------------------------------------
{
	let t = await open("font=system")
	let {page} = t
	await t.setDoc(sample + "\n")
	await sleep(50)
	let probed = await page.evaluate(() => ({has: view.atlas.ligaturesOf(0), wanted: view.atlas.ligaturesWanted}))
	check("system font: no ligatures found", probed.has === false && probed.wanted == 0, JSON.stringify(probed))
	let on = await t.shot(1, sample.length)
	await t.reconfigure({fontLigatures: false})
	check("system font: drawn exactly as without ligature support", on == await t.shot(1, sample.length))
	check("system font: no page errors", !t.errors.length, t.errors.join("; "))
	await page.close()
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed (${backend})`)
process.exit(failures ? 1 : 0)
