// CPU profile of typing on a USB-connected Android device (setup as in
// bench/device.mjs), with inclusive time for named functions:
//   node bench/device-profile.mjs "http://localhost:5199/?bare=1&ext=full"
//   NAMES=fn1,fn2  extra functions to report   FOCUS=fn  time spent under fn
import puppeteer from "puppeteer-core"
const [,, url] = process.argv
const browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
let page = (await browser.pages()).find(p => p.url().includes(":5199"))
await page.goto(url)
await page.waitForFunction("window.ready === true", {timeout: 60000})
await new Promise(r => setTimeout(r, 2500))
await page.evaluate(() => { let l = view.state.doc.line(12); view.scrollPosIntoView(l.from); view.dispatch({selection: {anchor: l.to}}); view.focus() })
await new Promise(r => setTimeout(r, 1500))
let cdp = await page.createCDPSession()
await cdp.send("Profiler.enable")
await cdp.send("Profiler.setSamplingInterval", {interval: 200})
await cdp.send("Profiler.start")
for (let ch of "const latency = measure(typing) // check it") { await page.keyboard.type(ch); await new Promise(r => setTimeout(r, 60)) }
await new Promise(r => setTimeout(r, 400))
let {profile} = await cdp.send("Profiler.stop")
let byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map()
for (let n of profile.nodes) for (let c of n.children ?? []) parent.set(c, n.id)
let names = (process.env.NAMES ?? "").split(",").filter(Boolean).concat(["apply", "frame", "ensureScene", "applyUpdate", "refreshDecorations", "runMeasures", "update", "completeAnyWord", "updateDeco", "createDeco", "buildSelectionLayers", "readMeasure", "writeMeasure", "measure", "observe", "lintSource", "dispatch", "onTextUpdate", "applyInput", "prepareRows", "placeBlocks", "getBoundingClientRect"])
let incl = new Map(names.map(n => [n, 0])), self = new Map(), total = 0
for (let i = 0; i < profile.samples.length; i++) {
	let d = (profile.timeDeltas[i] ?? 0) / 1000, seen = new Set(), leaf = byId.get(profile.samples[i]).callFrame
	if (leaf.functionName == "(idle)") continue
	total += d
	let key = `${leaf.functionName || "(anon)"} ${leaf.url.split("/").pop().split("?")[0]}:${leaf.lineNumber + 1}`
	self.set(key, (self.get(key) ?? 0) + d)
	for (let id = profile.samples[i]; id != null; id = parent.get(id)) {
		let name = byId.get(id).callFrame.functionName
		if (incl.has(name) && !seen.has(name)) { seen.add(name); incl.set(name, incl.get(name) + d) }
	}
}
if (process.env.FOCUS) {
	// Self time of functions called (directly or not) from FOCUS.
	let under = new Map()
	for (let i = 0; i < profile.samples.length; i++) {
		let d = (profile.timeDeltas[i] ?? 0) / 1000, leaf = byId.get(profile.samples[i]).callFrame, inside = false
		for (let id = profile.samples[i]; id != null; id = parent.get(id)) if (byId.get(id).callFrame.functionName == process.env.FOCUS) { inside = true; break }
		if (!inside) continue
		let path = [], id = profile.samples[i]
		for (let k = 0; k < 3 && id != null; k++, id = parent.get(id)) path.push(byId.get(id).callFrame.functionName || "(anon)")
		let key = path.join(" < ")
		under.set(key, (under.get(key) ?? 0) + d)
	}
	for (let [k, v] of [...under].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("  under " + v.toFixed(0) + "ms " + k)
}
console.log(`total ${total.toFixed(0)}ms over 43 keys`)
for (let [k, v] of incl) if (v > 1) console.log(`  incl ${k}: ${v.toFixed(0)}ms`)
for (let [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(v.toFixed(0).padStart(6) + "ms " + k)
await browser.disconnect()
