// Time to first syntax colors in Acode on a connected Android device
// (debug build, WebView devtools forwarded to localhost:9333):
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//   node bench/acode-startup.mjs [--cpu=4] [--mode=reload|switch] [--at=bottom] [--runs=3]
// reload: reload the app (files restored from storage); switch: switch to
// another open file for the first time after a reload. Reports when the
// file's text is drawn and when most visible lines have colors, for
// whichever renderer Acode is set to (canvas or dom).
import puppeteer from "puppeteer-core"
import {parseArgs, sleep} from "./harness.mjs"

const args = parseArgs()
const cpu = +(args.cpu ?? 4), mode = args.mode ?? "reload", runs = +(args.runs ?? 3)
const browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
const page = (await browser.pages()).find(p => p.url().endsWith("/index.html"))
const cdp = await page.createCDPSession()

// Polled in the page: {text, colored} for the active editor.
const probe = atBottom => {
	let em = window.editorManager, ed = em?.editor
	if (!ed || !em.activeFile?.loaded || em.activeFile.loading || !ed.state.doc.length) return {text: false, colored: false}
	let langMod = window.acode?.require?.("@codemirror/language")
	let lang = !!(langMod && ed.state.facet(langMod.language))
	let tree = langMod ? langMod.syntaxTree(ed.state).length : 0
	let doc = ed.state.doc, vp = ed.viewport
	// Bottom mode: only count once the end of the file is shown (its last
	// quarter: wrapped rows measured later can move the exact end).
	if (atBottom && vp.from < doc.length * 0.75) return {text: true, lang, colored: false, exact: false, file: em.activeFile.filename}
	let first = doc.lineAt(vp.from).number, last = doc.lineAt(vp.to).number, lines = 0, colored = 0, exact = 0
	if (ed.syntax) {
		ed.syntax.runsFor(first, last, (n, runs, isExact) => {
			if (!doc.line(n).text.trim()) return
			lines++
			// Window parses give provisional (but drawn) colors.
			if (runs && runs.length) colored++
			if (runs && runs.length && isExact) exact++
		})
	} else {
		for (let el of ed.contentDOM.querySelectorAll(".cm-line")) {
			if (!el.textContent.trim()) continue
			lines++
			if (el.querySelector("span[class*='ͼ'], span[class^='tok-']")) { colored++; exact++ }
		}
	}
	return {text: true, lang, parsed: ed.syntax ? ed.syntax.progress.treeLen >= vp.to : tree >= vp.to,
		colored: lines > 0 && colored >= lines * 0.6, exact: lines > 0 && exact >= lines * 0.6, renderer: ed.syntax ? "canvas" : "dom", file: em.activeFile.filename}
}

async function watch(t0) {
	let textAt = null, colorAt = null, exactAt = null, info = null, langAt = null, parsedAt = null
	while (performance.now() - t0 < 60000) {
		let r = await page.evaluate(probe, args.at == "bottom").catch(() => null)
		let t = performance.now() - t0
		if (r?.text && textAt == null) textAt = t
		if (r?.lang && langAt == null) langAt = t
		if (r?.parsed && parsedAt == null) parsedAt = t
		if (r?.colored && colorAt == null) colorAt = t
		if (r?.exact) { exactAt = t; info = r; break }
		if (r) info = r
		await sleep(15)
	}
	return {textAt, colorAt, exactAt, info, langAt, parsedAt}
}

let rows = []
for (let i = 0; i < runs; i++) {
	await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
	if (mode == "reload" && args.at == "bottom") {
		// Leave the active file at its end so the reload restores it there.
		await page.evaluate(async () => {
			let em = editorManager, ed = em.editor
			ed.scrollDOM.scrollTop = 1e9
			await new Promise(r => setTimeout(r, 500))
			let other = em.files.find(f => f != em.activeFile), self = em.activeFile
			em.switchFile(other.id)
			await new Promise(r => setTimeout(r, 500))
			em.switchFile(self.id)
			await new Promise(r => setTimeout(r, 1500))
		})
	}
	await page.reload({waitUntil: "domcontentloaded"}).catch(() => {})
	if (mode == "reload") {
		await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
		rows.push(await watch(performance.now()))
	} else {
		await page.waitForFunction(() => window.editorManager?.files?.length > 1 && editorManager.activeFile?.loaded, {timeout: 30000})
		await sleep(3000)
		await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
		let t0 = performance.now()
		// --at=bottom: the file was last viewed at its end (the worst case
		// for highlighting: everything above must be parsed).
		await page.evaluate(bottom => {
			let em = editorManager, f = em.files.find(f => f != em.activeFile)
			if (bottom) f.lastScrollTop = 1e7
			em.switchFile(f.id)
		}, args.at == "bottom")
		rows.push(await watch(t0))
	}
	await sleep(1500)
}
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
for (let r of rows) console.log(`${r.info?.renderer} ${r.info?.file}: text ${r.textAt?.toFixed(0)}ms, language ${r.langAt?.toFixed(0)}ms, colors ${r.colorAt?.toFixed(0) ?? "never"}ms, exact ${r.exactAt?.toFixed(0) ?? "never"}ms`)
await browser.disconnect()
