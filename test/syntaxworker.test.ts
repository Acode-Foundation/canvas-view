import {expect, test} from "bun:test"
import {EditorState, type Extension, type Text} from "@codemirror/state"
import {html, htmlLanguage} from "@codemirror/lang-html"
import {javascript, javascriptLanguage} from "@codemirror/lang-javascript"
import {LanguageSupport} from "@codemirror/language"
import {parseMixed} from "@lezer/common"
import {classHighlighter} from "@lezer/highlight"
import {SyntaxDriver} from "../src/view/syntax"
import {type SyntaxWorkerLike, syntaxWorker} from "../src/view/syntaxworker"
import {serveSyntax, type SyntaxLanguages} from "../src/worker"

const js = Array.from({length: 1500}, (_, i) =>
	`/** Doc ${i} */\nfunction f${i}(a, b) {\n  const s = \`v\${a + ${i}}\`\n  return [a, b, "x${i}"].map(x => x * 2) // c\n}`).join("\n")

const htmlDoc = `<!doctype html>\n<html>\n<head>\n<style>\nbody { color: red }\n</style>\n</head>\n<body>\n` +
	Array.from({length: 600}, (_, i) => `<div class="r${i}" style="color: blue" onclick="go(${i})"><span>item ${i}</span></div>`).join("\n") +
	`\n<script>\n${js.slice(0, 20000)}\n</script>\n</body>\n</html>\n`

/// A worker running in this thread, at the other end of a channel.
function inProcess(languages: SyntaxLanguages) {
	let channel = new MessageChannel()
	serveSyntax(languages, channel.port2)
	return () => channel.port1 as unknown as SyntaxWorkerLike
}

const languages = [javascriptLanguage, htmlLanguage]

const tick = () => new Promise(resolve => setTimeout(resolve, 2))

function driverFor(state: EditorState) {
	let queue: (() => void)[] = []
	let driver = new SyntaxDriver(state, classHighlighter, () => {}, cb => queue.push(cb))
	let run = () => {
		for (let i = 0; i < 50 && queue.length; i++) queue.shift()!()
	}
	return {driver, run, queue}
}

/// Run the driver's slices and let the worker reply until `done`.
async function settle(d: {driver: SyntaxDriver, run: () => void}, done: () => boolean, ms = 10_000) {
	let end = Date.now() + ms
	while (!done()) {
		if (Date.now() > end) throw new Error("Timed out: " + JSON.stringify(d.driver.progress))
		d.run()
		await tick()
	}
}

function runs(driver: SyntaxDriver, state: EditorState) {
	let out: string[] = []
	driver.runsFor(1, state.doc.lines, (n, runs, exact) => out.push(n + (exact ? "" : "?") + ":" +
		(runs ? Array.from({length: runs.length / 3}, (_, i) => runs[i * 3] + "-" + runs[i * 3 + 1] + driver.classes[runs[i * 3 + 2]]).join(" ") : "-")), false)
	return out
}

/// Runs of a driver that parsed `state`'s document on this thread.
function reference(state: EditorState, lang: Extension) {
	state = EditorState.create({doc: state.doc, extensions: lang})
	let {driver, queue} = driverFor(state)
	driver.setVisible(0, state.doc.length)
	for (let i = 0; i < 100_000 && queue.length; i++) queue.shift()!()
	expect(driver.progress.treeLen).toBe(state.doc.length)
	return runs(driver, state)
}

function stateWith(doc: string | Text, ...extensions: Extension[]) {
	return EditorState.create({doc, extensions})
}

for (let [name, doc, lang] of [["JavaScript", js, javascript()], ["HTML", htmlDoc, html()]] as const) {
	test(`${name} is parsed in the worker, with the same highlighting`, async () => {
		let state = stateWith(doc, lang, syntaxWorker(inProcess(languages)))
		let d = driverFor(state)
		d.driver.setVisible(0, 1500)
		await settle(d, () => d.driver.progress.treeLen == state.doc.length)
		expect(d.driver.progress.worker).toBe(true)
		expect(runs(d.driver, state)).toEqual(reference(state, lang))
		d.driver.destroy()
	})

	test(`${name} edits while the worker parses end in the same highlighting`, async () => {
		let state = stateWith(doc, lang, syntaxWorker(inProcess(languages)))
		let d = driverFor(state)
		d.driver.setVisible(0, 1500)
		d.run()
		for (let i = 0; i < 12; i++) {
			let at = Math.floor(state.doc.length * ((i * 0.37) % 1))
			let tr = state.update({changes: i % 3 == 2 ? {from: at, to: Math.min(state.doc.length, at + 5)} : {from: at, insert: i % 2 ? "x" : "\n"}})
			state = tr.state
			d.driver.update(state, tr.changes)
			d.run()
			if (i % 4 == 0) await tick()
		}
		await settle(d, () => d.driver.progress.treeLen == state.doc.length)
		expect(d.driver.progress.worker).toBe(true)
		let got = runs(d.driver, state), want = reference(state, lang)
		let diff = got.findIndex((l, i) => l != want[i])
		if (diff >= 0) console.log("first diff", diff, got.slice(diff, diff + 3), want.slice(diff, diff + 3))
		expect(got).toEqual(want)
		d.driver.destroy()
	})
}

test("the worker continues from the tree the main thread has", async () => {
	let state = stateWith(htmlDoc, html())
	// Parsed on this thread, kept for the document when the driver goes.
	let first = driverFor(state)
	first.driver.setVisible(0, 1500)
	for (let i = 0; i < 100_000 && first.queue.length; i++) first.queue.shift()!()
	first.driver.destroy()
	let sent: number[] = []
	let create = inProcess(languages)
	let spy = () => {
		let port = create()
		let post = port.postMessage.bind(port)
		port.postMessage = (m: any, transfer) => {
			if (m.t == "open") sent.push(m.seed ? m.seed.data.length : 0)
			post(m, transfer)
		}
		return port
	}
	state = stateWith(state.doc, html(), syntaxWorker(spy))
	let d = driverFor(state)
	d.driver.setVisible(0, 1500)
	d.run()
	expect(d.driver.progress.treeLen).toBe(state.doc.length)
	expect(d.driver.progress.worker).toBe(false)
	// An edit leaves the rest of the document to the worker, which gets
	// the tree to continue from.
	let tr = state.update({changes: {from: 400, insert: "<b>new</b>"}})
	state = tr.state
	d.driver.update(state, tr.changes)
	d.run()
	await tick()
	expect(sent.length).toBe(1)
	expect(sent[0]).toBeGreaterThan(0)
	await settle(d, () => d.driver.progress.treeLen == state.doc.length)
	expect(d.driver.progress.worker).toBe(true)
	expect(runs(d.driver, state)).toEqual(reference(state, html()))
})

/// Parsing falls back to this thread, and finishes there.
async function fallsBack(extension: Extension, doc = js, lang: Extension = javascript()) {
	let warn = console.warn
	let warnings: string[] = []
	console.warn = (m: string) => warnings.push(m)
	try {
		let state = stateWith(doc, lang, extension)
		let d = driverFor(state)
		d.driver.setVisible(0, 1500)
		await settle(d, () => d.driver.progress.treeLen == state.doc.length && !d.driver.progress.worker)
		expect(runs(d.driver, state)).toEqual(reference(state, lang))
		return warnings
	} finally {
		console.warn = warn
	}
}

test("falls back when the worker can't be created", async () => {
	let warnings = await fallsBack(syntaxWorker(() => { throw new Error("blocked") }))
	expect(warnings.join()).toContain("blocked")
})

test("falls back when the worker never answers", async () => {
	let channel = new MessageChannel()
	let warnings = await fallsBack(syntaxWorker(() => channel.port1 as unknown as SyntaxWorkerLike, {timeout: 100}))
	expect(warnings.join()).toContain("No reply")
})

test("falls back when the worker stops answering while it owes a tree", async () => {
	let channel = new MessageChannel()
	// Answers the handshake, then goes silent.
	channel.port2.onmessage = e => { if (e.data.t == "hello") channel.port2.postMessage({t: "hello", protocol: e.data.protocol}) }
	let warnings = await fallsBack(syntaxWorker(() => channel.port1 as unknown as SyntaxWorkerLike, {timeout: 100}))
	expect(warnings.join()).toContain("No reply")
})

test("falls back when the worker speaks another protocol", async () => {
	let channel = new MessageChannel()
	channel.port2.onmessage = e => { if (e.data.t == "hello") channel.port2.postMessage({t: "hello", protocol: 999}) }
	let warnings = await fallsBack(syntaxWorker(() => channel.port1 as unknown as SyntaxWorkerLike))
	expect(warnings.join()).toContain("protocol")
})

test("falls back when the worker reports an error", async () => {
	let worker = new EventTarget() as EventTarget & SyntaxWorkerLike
	let terminated = false
	worker.postMessage = () => {
		setTimeout(() => worker.dispatchEvent(Object.assign(new Event("error"), {message: "script failed"})), 5)
	}
	worker.terminate = () => { terminated = true }
	let warnings = await fallsBack(syntaxWorker(() => worker))
	expect(warnings.join()).toContain("script failed")
	expect(terminated).toBe(true)
})

test("falls back when a tree doesn't decode", async () => {
	let channel = new MessageChannel()
	channel.port2.onmessage = e => {
		let m = e.data
		if (m.t == "hello") channel.port2.postMessage({t: "hello", protocol: m.protocol})
		if (m.t == "open") channel.port2.postMessage({t: "tree", id: m.id, version: 0, len: 10,
			tree: {data: new Float64Array([1, 1, 0, 999, 10, 0, 0, 0]), buffer: new Uint16Array(0), sets: ["nope"], released: []}})
	}
	let warnings = await fallsBack(syntaxWorker(() => channel.port1 as unknown as SyntaxWorkerLike))
	expect(warnings.join()).toContain("decode")
})

test("a language the worker doesn't have is parsed here, others still in the worker", async () => {
	let create = inProcess([javascriptLanguage])
	let warnings = await fallsBack(syntaxWorker(create), htmlDoc, html())
	expect(warnings).toEqual([])
	let state = stateWith(js, javascript(), syntaxWorker(create))
	let d = driverFor(state)
	d.driver.setVisible(0, 1500)
	await settle(d, () => d.driver.progress.treeLen == state.doc.length)
	expect(d.driver.progress.worker).toBe(true)
})

test("a language configured differently in the worker is parsed here", async () => {
	let wrapped = new LanguageSupport(javascriptLanguage.configure({wrap: parseMixed(() => null)}))
	await fallsBack(syntaxWorker(inProcess(languages)), js, wrapped)
})

test("languages can be loaded by the worker when asked for", async () => {
	let asked: string[] = []
	let create = inProcess(async name => {
		asked.push(name)
		await tick()
		return name == "javascript" ? javascriptLanguage.parser : null
	})
	let state = stateWith(js, javascript(), syntaxWorker(create))
	let d = driverFor(state)
	d.driver.setVisible(0, 1500)
	// An edit arriving while the parser loads is applied after it.
	d.run()
	let tr = state.update({changes: {from: 100, insert: "let q = 1\n"}})
	state = tr.state
	d.driver.update(state, tr.changes)
	await settle(d, () => d.driver.progress.treeLen == state.doc.length)
	expect(asked).toEqual(["javascript"])
	expect(d.driver.progress.worker).toBe(true)
	expect(runs(d.driver, state)).toEqual(reference(state, javascript()))
})

test("a destroyed driver closes its document in the worker", async () => {
	let closed: number[] = []
	let create = inProcess(languages)
	let spy = () => {
		let port = create()
		let post = port.postMessage.bind(port)
		port.postMessage = (m: any, transfer) => {
			if (m.t == "close") closed.push(m.id)
			post(m, transfer)
		}
		return port
	}
	let state = stateWith(js, javascript(), syntaxWorker(spy))
	let d = driverFor(state)
	d.driver.setVisible(0, 1500)
	d.run()
	expect(d.driver.progress.worker).toBe(true)
	d.driver.destroy()
	await tick()
	expect(closed.length).toBe(1)
})
