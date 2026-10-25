// Switching editor tabs: `setState` between two large documents (as
// Acode does when switching tabs), timing the call, the first frame
// after it, and how long until the screen has exact syntax colors.
//   node bench/tabs.mjs [--cpu=4] [--lines=60000] [--profile]
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const cpu = +(args.cpu ?? 4), lines = +(args.lines ?? 60000)
const server = await serveDemo()
const browser = await launch(args)
let page = await phonePage(browser)
let cdp = await page.createCDPSession()
await page.goto(`${server.url}/index.html?kind=js&lines=${lines}&ext=full&bare=1`)
await page.waitForFunction("window.ready === true", {timeout: 120000})
await sleep(1500)
await page.evaluate(() => {
	let a = view.state
	let text = a.doc.toString()
	let b = cmApi.EditorState.create({doc: text.slice(text.length >> 1) + "\n" + text.slice(0, text.length >> 1),
		extensions: [cmApi.javascript(), cmApi.syntaxHighlighting(cmApi.classHighlighter)]})
	window.tabStates = [a, b]
	// Exact colors for every visible line.
	window.colored = () => {
		let ok = true, vp = view.viewport
		let first = view.state.doc.lineAt(vp.from).number, last = view.state.doc.lineAt(vp.to).number
		view.syntax.runsFor(first, last, (_n, _r, exact) => { if (!exact) ok = false })
		return ok
	}
})
await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
if (args.profile) {
	await cdp.send("Profiler.enable")
	await cdp.send("Profiler.setSamplingInterval", {interval: 100})
	await cdp.send("Profiler.start")
}
let rows = []
for (let i = 0; i < 12; i++) {
	rows.push(await page.evaluate(async i => {
		let next = tabStates[(i + 1) % 2]
		let t0 = performance.now()
		view.setState(next)
		// Like Acode: restore the scroll position after switching.
		view.scrollTop = view.lineTop(Math.min(next.doc.lines, 20000 + (i % 2) * 5000))
		let t1 = performance.now()
		await new Promise(r => requestAnimationFrame(r))
		let t2 = performance.now()
		while (!colored() && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 10))
		let t3 = performance.now()
		tabStates[(i + 1) % 2] = view.state
		return {setState: t1 - t0, firstFrame: t2 - t0, colored: t3 - t0}
	}, i))
	await sleep(400)
}
if (args.profile) {
	let {profile} = await cdp.send("Profiler.stop")
	let self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]))
	profile.samples.forEach((s, i) => {
		let f = byId.get(s).callFrame
		if (f.functionName == "(idle)") return
		let key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`
		self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000)
	})
	for (let [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v.toFixed(1).padStart(8), k)
}
let med = k => rows.map(r => r[k]).sort((a, b) => a - b)[rows.length >> 1].toFixed(1)
let max = k => Math.max(...rows.map(r => r[k])).toFixed(1)
console.log(`cpu ${cpu}x, ${lines} lines: setState median ${med("setState")}ms (max ${max("setState")}), first frame ${med("firstFrame")}ms (max ${max("firstFrame")}), exact colors ${med("colored")}ms (max ${max("colored")})`)
console.log(rows.map(r => `${r.setState.toFixed(0)}/${r.firstFrame.toFixed(0)}/${r.colored.toFixed(0)}`).join("  "))
await browser.close()
server.close()
