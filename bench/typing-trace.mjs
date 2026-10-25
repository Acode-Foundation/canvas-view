// Attributes typing latency spikes: traces typing (tasks, GC, CPU samples
// on one clock), then for each key splits key event → presented frame into
// what ran in between, and compares the slowest keys with a typical one.
//   node bench/typing-trace.mjs [--cpu=20] [--query=ext=full] [--impl=canvas|cm]
//   node bench/typing-trace.mjs --device [--cpu=20]   (USB phone: serves
//     demo-dist on :5199 itself; needs adb reverse tcp:5199 tcp:5199 and
//     adb forward tcp:9333 localabstract:chrome_devtools_remote)
// --json=file saves the per-key breakdown.
import {writeFile} from "node:fs/promises"
import puppeteer from "puppeteer-core"
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const cpu = +(args.cpu ?? 20), text = args.text ?? "const latency = measure(typing) // check it"
const server = await serveDemo(args.device ? 5199 : 0)
let browser, page
if (args.device) {
	browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
	let pages = await browser.pages()
	page = pages.find(p => p.url().includes(":5199")) ?? pages[0]
} else {
	browser = await launch(args)
	page = await phonePage(browser)
}
const html = args.impl == "cm" ? "cm.html" : "index.html"
await page.goto(`${server.url.replace(/127\.0\.0\.1|\[::\]/, "localhost")}/${html}?kind=js&lines=${args.lines ?? 120000}&bare=1${args.query ? "&" + args.query : ""}`)
await page.waitForFunction("window.ready === true", {timeout: 120000})
await sleep(2500)
await page.evaluate(`{
	let v = window.view ?? window.cm
	let l = v.state.doc.line(LINE)
	v.dispatch({selection: {anchor: l.to}, scrollIntoView: true})
	v.focus()
}`.replace("LINE", String(+(args.line ?? 12))))
await sleep(1500)
const cdp = await page.createCDPSession()
await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
// Key event → the end of the frame showing it (rAF, then a message: the
// frame's own work is done), like bench/compare.mjs.
await page.evaluate(() => {
	window.__keys = []
	let channel = new MessageChannel(), pending = []
	channel.port1.onmessage = () => { let k = pending.shift(); if (k) k.end = performance.now() }
	document.addEventListener("keydown", e => {
		let k = {key: e.key, t0: e.timeStamp, handled: performance.now()}
		window.__keys.push(k)
		requestAnimationFrame(() => { pending.push(k); channel.port2.postMessage(null) })
	}, true)
})
await sleep(500)
const categories = ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "v8",
	"blink.user_timing", "disabled-by-default-v8.cpu_profiler", "disabled-by-default-v8.gc", "blink", "gpu", "cc", "viz"]
await page.tracing.start({categories})
await sleep(200)
const sync = await page.evaluate(() => performance.mark("__sync").startTime)
for (let ch of text) { await page.keyboard.type(ch); await sleep(+(args.gap ?? 60)) }
await sleep(800)
const keys = await page.evaluate(() => window.__keys)
const trace = JSON.parse(new TextDecoder().decode(await page.tracing.stop()))
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
const events = trace.traceEvents ?? trace

// Clock alignment: the sync mark's trace ts (µs) vs its performance.now().
const syncEv = events.find(e => e.name == "__sync")
if (!syncEv) throw new Error("sync mark not in trace")
const offset = syncEv.ts / 1000 - sync, toTrace = t => t + offset
const pid = syncEv.pid
const mainTid = events.find(e => e.ph == "M" && e.name == "thread_name" && e.pid == pid && e.args.name == "CrRendererMain")?.tid
const main = events.filter(e => e.pid == pid && e.tid == mainTid)

// CPU samples of the main thread (ProfileChunk), with stacks.
const nodes = new Map(), samples = []
for (let profileId of new Set(main.filter(e => e.name == "Profile").map(e => e.id))) {
	let start = main.find(e => e.name == "Profile" && e.id == profileId).args.data.startTime
	let t = start
	for (let e of events.filter(e => e.name == "ProfileChunk" && e.id == profileId && e.pid == pid)) {
		let d = e.args.data, cp = d.cpuProfile ?? {}
		for (let n of cp.nodes ?? []) nodes.set(n.id, n)
		let ss = cp.samples ?? [], dt = d.timeDeltas ?? []
		for (let i = 0; i < ss.length; i++) { t += dt[i] ?? 0; samples.push({t: t / 1000, id: ss[i]}) }
	}
}
samples.sort((a, b) => a.t - b.t)
for (let i = 0; i < samples.length; i++) samples[i].d = i + 1 < samples.length ? Math.min(samples[i + 1].t - samples[i].t, 2) : 0
const stackOf = id => {
	let out = []
	for (let n = nodes.get(id); n; n = nodes.get(n.parent)) out.push(n.callFrame.functionName || "(anon)")
	return out
}
const IGNORE = new Set(["(root)", "(program)", "(idle)", "(anon)", "(garbage collector)"])

// Per key: tasks overlapping its window, GC, frames, CPU attribution.
const tasks = main.filter(e => e.ph == "X" && e.name == "RunTask" && e.dur)
const named = ["EventDispatch", "FunctionCall", "FireAnimationFrame", "TimerFire", "MinorGC", "MajorGC", "V8.GC_SCAVENGER",
	"V8.GC_MC_BACKGROUND", "MajorGC", "V8.GCFinalizeMC", "V8.GCScavenger", "BlinkGC.AtomicPhase", "UpdateLayoutTree", "Layout",
	"Paint", "PrePaint", "Commit", "HitTest", "ParseHTML", "EvaluateScript", "RunMicrotasks"]
const rows = []
for (let i = 0; i < keys.length; i++) {
	let k = keys[i]
	if (k.end == null) continue
	let a = toTrace(k.t0) * 1000, b = toTrace(k.end) * 1000
	let inWin = e => e.ts < b && e.ts + (e.dur ?? 0) > a
	let clip = e => (Math.min(b, e.ts + e.dur) - Math.max(a, e.ts)) / 1000
	let ts = tasks.filter(inWin)
	let busy = ts.reduce((s, e) => s + clip(e), 0)
	let byName = {}
	for (let e of main) if (e.ph == "X" && e.dur && named.includes(e.name) && inWin(e)) {
		let n = e.name == "EventDispatch" ? "Event:" + e.args?.data?.type : e.name
		byName[n] = (byName[n] ?? 0) + clip(e)
	}
	let incl = {}, self = {}, cpuMs = 0
	for (let s of samples) {
		if (s.t * 1000 < a || s.t * 1000 >= b) continue
		let st = stackOf(s.id)
		if (st[0] == "(idle)") continue
		cpuMs += s.d
		self[st[0]] = (self[st[0]] ?? 0) + s.d
		for (let f of new Set(st)) if (!IGNORE.has(f)) incl[f] = (incl[f] ?? 0) + s.d
	}
	let top = ts.map(e => ({start: +((e.ts - a) / 1000).toFixed(1), dur: +(e.dur / 1000).toFixed(1)})).filter(t => t.dur > 1)
	rows.push({i, key: k.key, latency: k.end - k.t0, queued: k.handled - k.t0, busy, cpuMs, byName, incl, self, tasks: top})
}

const fmt = n => n.toFixed(1).padStart(7)
const sorted = [...rows].sort((a, b) => a.latency - b.latency)
const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].latency
console.log(`${args.device ? "device" : "local"} ${args.impl ?? "canvas"} cpu=${cpu} keys=${rows.length} latency p50 ${pct(.5).toFixed(1)} p95 ${pct(.95).toFixed(1)} max ${sorted.at(-1).latency.toFixed(1)}`)
console.log("  key latency queued   busy  tasks>1ms")
for (let r of rows) console.log(`${String(r.i).padStart(3)} ${JSON.stringify(r.key).padEnd(4)}${fmt(r.latency)}${fmt(r.queued)}${fmt(r.busy)}  ${r.tasks.map(t => `${t.dur}@${t.start}`).join(" ")}`)

// Inclusive-time comparison: the slowest keys vs the median ones.
const avg = (rs, key) => {
	let m = {}
	for (let r of rs) for (let [k, v] of Object.entries(r[key])) m[k] = (m[k] ?? 0) + v / rs.length
	return m
}
const slow = [...rows].sort((a, b) => b.latency - a.latency).slice(0, Math.max(3, Math.round(rows.length * 0.1)))
const mid = sorted.slice(Math.floor(sorted.length * 0.3), Math.ceil(sorted.length * 0.7))
for (let key of ["byName", "incl", "self"]) {
	let s = avg(slow, key), m = avg(mid, key)
	let names = [...new Set([...Object.keys(s), ...Object.keys(m)])].sort((x, y) => (s[y] ?? 0) - (m[y] ?? 0) - ((s[x] ?? 0) - (m[x] ?? 0)))
	console.log(`\n${key}: slowest ${slow.length} keys (avg ms) vs median keys, sorted by excess`)
	for (let n of names.slice(0, +(args.top ?? 22))) console.log(`${fmt(s[n] ?? 0)}${fmt(m[n] ?? 0)}  ${n}`)
}
// Top-down: stack paths (root side, --depth frames) over the median keys.
{
	let depth = +(args.depth ?? 4), paths = new Map(), n = 0
	for (let r of mid) {
		let k = keys[r.i], a = toTrace(k.t0), b = toTrace(k.end)
		n++
		for (let s of samples) {
			if (s.t < a || s.t >= b) continue
			let st = stackOf(s.id).reverse().filter(f => f != "(root)")
			if (st[0] == "(idle)") continue
			if (args.under) {
				let at = st.indexOf(args.under)
				if (at < 0) continue
				st = st.slice(at)
			}
			let key = st.slice(0, depth).join(" > ")
			paths.set(key, (paths.get(key) ?? 0) + s.d)
		}
	}
	console.log(`\ntop-down paths (depth ${depth}), avg ms per median key`)
	for (let [p, v] of [...paths].sort((a, b) => b[1] - a[1]).slice(0, +(args.paths ?? 30))) console.log(`${fmt(v / n)}  ${p}`)
}
// Self time of trace events (native work included) over the median keys.
{
	let selfT = new Map(), n = 0
	let xs = main.filter(e => e.ph == "X" && e.dur).sort((a, b) => a.ts - b.ts || b.dur - a.dur)
	for (let r of mid) {
		let k = keys[r.i], a = toTrace(k.t0) * 1000, b = toTrace(k.end) * 1000
		n++
		let stack = []
		for (let e of xs) {
			if (e.ts + e.dur <= a || e.ts >= b) continue
			while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop()
			let d = (Math.min(b, e.ts + e.dur) - Math.max(a, e.ts)) / 1000
			let parent = stack.at(-1)
			if (parent) selfT.set(parent.name, (selfT.get(parent.name) ?? 0) - d)
			selfT.set(e.name, (selfT.get(e.name) ?? 0) + d)
			stack.push(e)
		}
	}
	console.log(`\ntrace event self time, avg ms per median key`)
	for (let [p, v] of [...selfT].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${fmt(v / n)}  ${p}`)
}
if (args.trace) await writeFile(args.trace, JSON.stringify(events))
if (args.json) await writeFile(args.json, JSON.stringify(rows, null, 1))
if (args.device) await browser.disconnect()
else await browser.close()
server.close()
