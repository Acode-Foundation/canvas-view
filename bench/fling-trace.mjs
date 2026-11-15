// Where a fling's main-thread time goes outside the view's own JS: traces
// flings and sums the self time of trace events on the renderer's main
// thread by name (what the CPU profile reports as "(program)").
//   node bench/fling-trace.mjs [--backend=webgl2] [--cpu=6] [--what=typing] [--query=...]
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const backend = args.backend ?? "webgl2", cpu = +(args.cpu ?? 6)
const server = await serveDemo()
const browser = await launch(args)
const page = await phonePage(browser)
await page.goto(`${server.url}/index.html?kind=js&lines=120000&backend=${backend}&bare=1${args.query ? "&" + args.query : ""}`)
await page.waitForFunction("window.ready === true")
const cdp = await page.createCDPSession()
await sleep(1500)
await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
await page.tracing.start({categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "gpu", "cc", "viz", "input", "v8", "blink.user_timing"]})
const sync = await page.evaluate(() => performance.mark("__sync").startTime)
const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints: type == "touchEnd" ? [] : [{x: 206, y, id: 1}]})
if (args.what == "typing") {
	await page.evaluate(() => { let l = view.state.doc.line(12); view.dispatch({selection: {anchor: l.to}}); view.focus() })
	for (let ch of "const latency = measure(typing) // check it") { await page.keyboard.type(ch); await sleep(45) }
} else for (let i = 0; i < 4; i++) {
	await touch("touchStart", 700)
	for (let k = 1; k <= 12; k++) { await sleep(8); await touch("touchMove", 700 - 500 * k / 12) }
	await touch("touchEnd")
	await sleep(2200)
}
const trace = JSON.parse(new TextDecoder().decode(await page.tracing.stop()))
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
const stats = await page.evaluate(() => view.stats)
const events = trace.traceEvents ?? trace
const syncEv = events.find(e => e.name == "__sync")
if (!syncEv) throw new Error("sync mark not in trace")
void sync
const pid = syncEv.pid
const mainTid = events.find(e => e.ph == "M" && e.name == "thread_name" && e.pid == pid && e.args.name == "CrRendererMain")?.tid

// Self time per event name: complete events on one thread nest, so a
// stack of open events gives each one's children.
function selfTimes(tid) {
	let list = events.filter(e => e.pid == pid && e.tid == tid && e.ph == "X" && e.dur != null).sort((a, b) => a.ts - b.ts || b.dur - a.dur)
	let self = new Map(), stack = [], total = 0
	let add = (name, us) => self.set(name, (self.get(name) ?? 0) + us)
	for (let e of list) {
		while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop()
		let top = stack[stack.length - 1]
		// Thread time where the trace has it: with CPU throttling, wall
		// time includes the throttler's sleeps.
		let dur = e.dur
		if (top) add(top.name, -Math.min(dur, top.end - e.ts))
		else total += dur
		add(e.name, dur)
		stack.push({name: e.name, end: e.ts + e.dur})
	}
	return {self, total}
}

const frames = stats.length
const {self, total} = selfTimes(mainTid)
console.log(`${backend} cpu=${cpu}: ${frames} frames, main thread busy ${(total / 1000).toFixed(0)}ms (${(total / 1000 / frames).toFixed(2)}ms/frame), view JS ${(stats.reduce((a, s) => a + s.work, 0)).toFixed(0)}ms`)
for (let [name, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +(args.top ?? 28)))
	console.log(`${(us / 1000).toFixed(1).padStart(8)}ms ${(us / 1000 / frames).toFixed(3).padStart(7)}/frame  ${name}`)
await browser.close()
server.close()
