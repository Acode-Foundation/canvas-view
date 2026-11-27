// Browser test for syntax parsing in a worker (`syntaxWorker`, the
// demo's `worker=1`): the worker's trees give the same colors as parsing
// on the main thread, before and after typing; they're shared with the
// state's language field; colors reach the screen during a fling right
// after load; and a worker that doesn't load falls back to the main
// thread.
//
//   node test/browser/worker.mjs [--backend=webgl2|webgpu]

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

async function open(query, cpu = 1) {
	let page = await browser.newPage()
	if (cpu > 1) await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", {rate: cpu})
	let errors = [], warnings = []
	page.on("pageerror", e => errors.push(e.message))
	page.on("console", m => {
		if (m.type() == "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text())
		if (m.type() == "warn" || m.type() == "warning") warnings.push(m.text())
	})
	await page.setViewport({width: 412, height: 860, deviceScaleFactor: 2})
	await page.goto(`${server.url}/index.html?backend=${backend}&bare=1&ext=basic&blink=0&${query}`)
	await page.waitForFunction("window.ready === true")
	return {page, errors, warnings}
}

/// Wait for the whole document to be parsed (the main thread only parses
/// 400k chars past the screen, so the screen is moved to the end).
const parsed = page => page.evaluate(async () => {
	let s = view.syntax
	s.setVisible(0, view.state.doc.length)
	let end = performance.now() + 30000
	while (s.progress.treeLen < s.progress.docLength && performance.now() < end) await new Promise(r => setTimeout(r, 20))
	return s.progress
})

/// A digest of the highlighting of every 37th line.
const digest = page => page.evaluate(() => {
	let s = view.syntax, doc = view.state.doc, out = [], inexact = 0
	for (let n = 1; n <= doc.lines; n += 37) s.runsFor(n, n, (k, r, e) => {
		if (!e) inexact++
		out.push(k + ":" + (r ? Array.from(r).map((v, i) => i % 3 == 2 ? s.classes[v] : v).join(",") : "-"))
	}, false)
	let h = 0, str = out.join("\n")
	for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
	return {hash: h, lines: out.length, inexact}
})

const typing = async page => {
	await page.evaluate(() => {
		view.focus()
		view.dispatch({selection: {anchor: view.state.doc.line(30).to}})
	})
	await page.keyboard.type(" <b>x</b>")
	await page.keyboard.press("Enter")
	await page.keyboard.type("<script>let q = `a${1}`</script>")
	await sleep(50)
}

for (let kind of ["html", "js"]) {
	let lines = kind == "html" ? 20000 : 60000
	let worker = await open(`kind=${kind}&lines=${lines}&worker=1`)
	let main = await open(`kind=${kind}&lines=${lines}&worker=0`)
	let wp = await parsed(worker.page), mp = await parsed(main.page)
	check(`${kind}: parsed in the worker`, wp.worker && wp.treeLen == wp.docLength, JSON.stringify(wp))
	check(`${kind}: parsed on the main thread without it`, !mp.worker && mp.treeLen == mp.docLength, JSON.stringify(mp))
	let wd = await digest(worker.page), md = await digest(main.page)
	check(`${kind}: same colors`, wd.hash == md.hash && wd.inexact == 0, JSON.stringify({wd, md}))
	// The state's language field gets the worker's tree (after a frame:
	// a background tab draws none).
	await worker.page.bringToFront()
	await sleep(600)
	let shared = await worker.page.evaluate(() => cmApi.syntaxTree(view.state).length == view.state.doc.length)
	check(`${kind}: tree shared with the state`, shared)
	await typing(worker.page)
	await main.page.bringToFront()
	await typing(main.page)
	wp = await parsed(worker.page)
	mp = await parsed(main.page)
	wd = await digest(worker.page)
	md = await digest(main.page)
	check(`${kind}: same colors after typing`, wp.worker && wd.hash == md.hash && wd.inexact == 0, JSON.stringify({wp, wd, md}))
	check(`${kind}: no errors or warnings`, !worker.errors.length && !worker.warnings.length,
		[...worker.errors, ...worker.warnings].join("; "))
	await worker.page.close()
	await main.page.close()
}

// Right after loading a mixed-language file, a fling at 6× CPU: the
// main thread parses only one slice per frame while it moves, so colors
// come from the worker. (CDP's throttling doesn't slow workers, so this
// flatters the worker; a phone is the real check.)
{
	let flingColors = async query => {
		let {page} = await open(query, 6)
		return page.evaluate(async () => {
			view.recordStats = true
			view.stats.length = 0
			view.fling(0, 6000)
			await new Promise(r => setTimeout(r, 2500))
			view.recordStats = false
			let frames = view.stats.filter(s => s.scrollTop > 0)
			return {frames: frames.length, plain: frames.filter(s => s.plainLines > 0).length}
		}).finally(() => page.close())
	}
	let withWorker = await flingColors("kind=html&lines=20000&worker=1")
	let without = await flingColors("kind=html&lines=20000&worker=0")
	console.log(`     fling right after load, frames with uncolored lines: worker ${withWorker.plain}/${withWorker.frames}, main thread ${without.plain}/${without.frames}`)
	check("fling after load: fewer uncolored frames with the worker", withWorker.plain <= without.plain,
		JSON.stringify({withWorker, without}))
}

// A worker that doesn't load: parsing falls back to the main thread.
{
	let {page, warnings, errors} = await open("kind=html&lines=4000&worker=missing")
	let p = await parsed(page)
	let d = await digest(page)
	check("missing worker: parsed on the main thread", !p.worker && p.treeLen == p.docLength && d.inexact == 0, JSON.stringify({p, d}))
	check("missing worker: says so", warnings.some(w => /syntax worker failed/.test(w)), warnings.join("; "))
	check("missing worker: no errors", !errors.length, errors.join("; "))
	await page.close()
}

await browser.close()
server.close()
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
