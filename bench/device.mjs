// Fling benchmark on a USB-connected Android device, over DevTools.
// Setup: adb reverse tcp:5199 tcp:5199 (vite dev server on 5199), open
// any page in the device browser, adb forward tcp:9333 localabstract:chrome_devtools_remote
//   node bench/device.mjs "http://localhost:5199/?kind=js&lines=120000&bare=1" [screenshot.png]
import puppeteer from "puppeteer-core"
const [,, url, out] = process.argv
const browser = await puppeteer.connect({browserURL: "http://localhost:9333", defaultViewport: null})
let pages = await browser.pages()
let page = pages.find(p => p.url().includes(":5199")) ?? pages[0]
await page.goto(url)
await page.waitForFunction("window.ready === true", {timeout: 60000})
await new Promise(r => setTimeout(r, 2000))
let info = await page.evaluate(() => ({ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight,
	backend: view.debug.backend, rows: view.debug.rows, lines: view.state.doc.lines, wrap: view.debug.wrap}))
console.log(JSON.stringify(info))
// Flings through the view API (same spline as a finger release), with frame stats.
let res = await page.evaluate(async () => {
	view.recordStats = true
	let moving = [], iv = []
	for (let i = 0; i < 6; i++) {
		view.stats.length = 0
		view.fling(0, i % 3 == 2 ? -6000 : 6000)
		await new Promise(r => setTimeout(r, 2600))
		let run = view.stats.splice(0)
		for (let k = 1; k < run.length; k++) {
			if (run[k].scrollTop == run[k - 1].scrollTop) continue
			moving.push(run[k])
			iv.push(run[k].time - run[k - 1].time)
		}
	}
	let pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0
	let work = moving.map(f => f.work)
	return {frames: moving.length, intervalP50: pct(iv, .5), intervalP95: pct(iv, .95), intervalMax: Math.max(...iv),
		workP50: pct(work, .5), workP95: pct(work, .95), workMax: Math.max(...work),
		plain: moving.filter(f => f.plainLines).length,
		slowest: [...moving].sort((a, b) => b.work - a.work).slice(0, 3).map(f => ({work: +f.work.toFixed(1), scene: +f.sceneMs.toFixed(1),
			rows: +f.rowsMs.toFixed(1), vp: +f.viewportMs.toFixed(1), dyn: +f.dynMs.toFixed(1), atlas: +f.atlasMs.toFixed(1), render: +f.renderMs.toFixed(1), texels: f.atlasTexels}))}
})
console.log(JSON.stringify(res))
// Typing: key event → end of the frame that shows it, plus main-thread
// time per key (same method as bench/compare.mjs).
await page.evaluate(() => { let l = view.state.doc.line(12); view.scrollPosIntoView(l.from); view.dispatch({selection: {anchor: l.to}}); view.focus() })
await new Promise(r => setTimeout(r, 1500))
await page.evaluate(() => {
	window.__typing = []
	let channel = new MessageChannel(), pending = []
	channel.port1.onmessage = () => { let t = pending.shift(); if (t != null) window.__typing.push(performance.now() - t) }
	document.addEventListener("keydown", e => {
		let t0 = e.timeStamp
		requestAnimationFrame(() => { pending.push(t0); channel.port2.postMessage(null) })
	}, true)
})
for (let ch of "const latency = measure(typing) // check it") {
	await page.keyboard.type(ch)
	await new Promise(r => setTimeout(r, 60))
}
await new Promise(r => setTimeout(r, 300))
let typing = await page.evaluate(() => {
	let a = [...window.__typing].sort((x, y) => x - y), p = q => a[Math.min(a.length - 1, Math.floor(a.length * q))]
	return {n: a.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1)}
})
console.log(JSON.stringify({typing}))
if (out) await page.screenshot({path: out})
await browser.disconnect()
