// Prints the slowest frames with their time breakdown, to attribute
// spikes. Usage: node bench/worst.mjs [--backend=webgpu] [--cpu=6]
//   [--kind=js] [--query=dir=auto&wrap=1]
import {launch, parseArgs, phonePage, serveDemo, sleep} from "./harness.mjs"

const args = parseArgs()
const backend = args.backend ?? "webgpu", cpu = +(args.cpu ?? 6)
const server = await serveDemo()
const browser = await launch(args)
const page = await phonePage(browser)
const kind = args.kind ?? "js", query = args.query ? "&" + args.query : ""
await page.goto(`${server.url}/index.html?kind=${kind}&lines=120000&backend=${backend}&bare=1${query}`)
await page.waitForFunction("window.ready === true")
const cdp = await page.createCDPSession()
await new Promise(r => setTimeout(r, 500))
await page.evaluate(() => { view.stats.length = 0; view.recordStats = true })
await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu})
for (let i = 0; i < 6; i++) {
	await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 206, y: 700, id: 1}]})
	for (let k = 1; k <= 12; k++) {
		await sleep(8)
		await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 206, y: 700 - 500 * k / 12, id: 1}]})
	}
	await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []})
	await sleep(1800)
}
await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1})
const stats = await page.evaluate(() => view.stats)
stats.forEach((s, i) => s.index = i)
const worst = [...stats].sort((a, b) => b.work - a.work).slice(0, 8)
const f = n => n.toFixed(2).padStart(7)
console.log(`${backend} cpu=${cpu} frames=${stats.length}`)
console.log("  idx    work   scene     dyn   atlas  render  rows rebuilt")
for (let s of worst) console.log(`${String(s.index).padStart(5)} ${f(s.work)} ${f(s.sceneMs)} ${f(s.dynMs)} ${f(s.atlasMs)} ${f(s.renderMs)} ${String(s.atlasRows).padStart(5)} ${s.rebuilt}`)
const avg = k => stats.reduce((a, s) => a + s[k], 0) / stats.length
console.log(`mean: work ${avg("work").toFixed(3)} scene ${avg("sceneMs").toFixed(3)} dyn ${avg("dynMs").toFixed(3)} atlas ${avg("atlasMs").toFixed(3)} render ${avg("renderMs").toFixed(3)}`)
await browser.close()
server.close()
