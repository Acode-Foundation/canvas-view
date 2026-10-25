// CPU profile of typing or flinging in the demo, aggregated by function
// (self time), to find hot spots:
//   node bench/profile.mjs --what=typing|fling|load [--cpu=6] [--query=...]
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const what = args.what ?? "typing", cpu = +(args.cpu ?? 6)
const server = await serveDemo()
const browser = await launch(args)
let page = await phonePage(browser)
let cdp = await page.createCDPSession()
await cdp.send("Profiler.enable")
await cdp.send("Profiler.setSamplingInterval", {interval: 100})
let url = `${server.url}/index.html?kind=js&lines=${args.lines ?? 120000}&bare=1${args.query ? "&" + args.query : ""}`
if (what == "load") await cdp.send("Profiler.start")
await page.goto(url)
await page.waitForFunction("window.ready === true", {timeout: 120000})
await sleep(1500)
await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
if (what != "load") {
	if (what == "after-fling") {
		// Like bench/compare.mjs: flings first, then typing at the top.
		let touch = (type, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x: 206, y, id: 1}]})
		for (let i = 0; i < 6; i++) {
			await touch("touchStart", 700)
			for (let k = 1; k <= 12; k++) { await sleep(8); await touch("touchMove", 700 - 500 * k / 12) }
			await touch("touchEnd")
			await sleep(1500)
		}
	}
	if (what == "typing" || what == "after-fling") {
		await page.evaluate(() => { let l = view.state.doc.line(12); view.dispatch({selection: {anchor: l.to}}); view.focus() })
		await sleep(300)
	}
	await cdp.send("Profiler.start")
	if (what == "typing" || what == "after-fling") {
		for (let ch of "const latency = measure(typing) // check it") { await page.keyboard.type(ch); await sleep(45) }
	} else {
		let touch = (type, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x: 206, y, id: 1}]})
		for (let i = 0; i < 4; i++) {
			await touch("touchStart", 700)
			for (let k = 1; k <= 12; k++) { await sleep(8); await touch("touchMove", 700 - 500 * k / 12) }
			await touch("touchEnd")
			await sleep(2200)
		}
	}
	await sleep(300)
}
let {profile} = await cdp.send("Profiler.stop")
let self = new Map(), total = 0
let byId = new Map(profile.nodes.map(n => [n.id, n]))
let dt = profile.timeDeltas, samples = profile.samples
for (let i = 0; i < samples.length; i++) {
	let n = byId.get(samples[i]), f = n.callFrame
	let key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`
	if (f.functionName == "(idle)" || f.functionName == "(program)" && false) continue
	let d = (dt[i] ?? 0) / 1000
	self.set(key, (self.get(key) ?? 0) + d)
	total += d
}
// Inclusive time of chosen functions (outermost call only).
if (args.inclusive) {
	let names = args.inclusive.split(",")
	let parent = new Map()
	for (let n of profile.nodes) for (let c of n.children ?? []) parent.set(c, n.id)
	let incl = new Map(names.map(n => [n, 0]))
	for (let i = 0; i < samples.length; i++) {
		let d = (dt[i] ?? 0) / 1000, seen = new Set()
		for (let id = samples[i]; id != null; id = parent.get(id)) {
			let name = byId.get(id).callFrame.functionName
			if (incl.has(name) && !seen.has(name)) { seen.add(name); incl.set(name, incl.get(name) + d) }
		}
	}
	for (let [k, v] of incl) console.log(`inclusive ${k}: ${v.toFixed(1)}ms`)
}
let rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, +(args.top ?? 30))
console.log(`total sampled (non-idle) ${total.toFixed(0)}ms at ${cpu}x`)
for (let [k, v] of rows) console.log(v.toFixed(1).padStart(8) + "ms  " + k)
await browser.close()
server.close()
