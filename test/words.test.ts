import {expect, test} from "bun:test"
import {CompletionContext, type CompletionResult} from "@codemirror/autocomplete"
import {ChangeSet, EditorState, Text, type TransactionSpec} from "@codemirror/state"
import {completeWords, WordSet, wordIndex} from "../src/view/words"

/// Counts of a fresh scan of `doc`.
function fresh(doc: Text, wordChars = "") {
	let set = new WordSet(wordChars, doc, 2)
	set.build(Infinity)
	return new Map([...set.counts].sort())
}

function sorted(m: Map<string, number>) {
	return new Map([...m].sort())
}

/// Deterministic pseudo-random numbers.
function rng(seed: number) {
	return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
}

const WORDS = ["alpha", "beta", "gamma", "alphabet", "x", "Beta", "été", "naïve", "foo_bar", "42", "a1"]

function randomText(r: () => number, n: number) {
	let out = ""
	for (let i = 0; i < n; i++) {
		let x = r()
		out += x < 0.15 ? "\n" : x < 0.3 ? " " : x < 0.35 ? "." : WORDS[Math.floor(r() * WORDS.length)]
	}
	return out
}

test("counts stay equal to a fresh scan through random edits", () => {
	let r = rng(7)
	for (let round = 0; round < 40; round++) {
		let doc = Text.of(randomText(r, 300).split("\n"))
		let set = new WordSet("", doc, 2)
		set.build(Infinity)
		for (let step = 0; step < 25; step++) {
			// A few changes per update, several updates per sync, like
			// typing between completion queries.
			let changes: {from: number, to: number, insert: string}[] = []
			let pos = 0
			for (let k = 0; k < 3 && pos < doc.length; k++) {
				let from = pos + Math.floor(r() * Math.min(40, doc.length - pos))
				let to = Math.min(doc.length, from + Math.floor(r() * (r() < 0.2 ? 60 : 4)))
				changes.push({from, to, insert: r() < 0.3 ? "" : randomText(r, 1 + Math.floor(r() * 6))})
				pos = to + 1
			}
			let cs = ChangeSet.of(changes, doc.length)
			set.noteChanges(cs)
			doc = cs.apply(doc)
			if (r() < 0.5) {
				if (!set.sync(doc)) set.build(Infinity)
				expect(sorted(set.counts)).toEqual(fresh(doc))
			}
		}
		if (!set.sync(doc)) set.build(Infinity)
		expect(sorted(set.counts)).toEqual(fresh(doc))
	}
})

test("building in slices, with changes while it builds", () => {
	let doc = Text.of(Array.from({length: 5000}, (_, i) => `line${i} alpha beta${i % 7}`))
	let set = new WordSet("", doc, 2)
	expect(set.build(-1)).toBe(false)
	let cs = ChangeSet.of([{from: 0, to: 5, insert: "renamed"}, {from: doc.length, insert: "\ntail gamma"}], doc.length)
	set.noteChanges(cs)
	doc = cs.apply(doc)
	while (!set.build(performance.now() + 1)) {}
	expect(set.sync(doc)).toBe(true)
	expect(sorted(set.counts)).toEqual(fresh(doc))
})

test("big changes start over", () => {
	let doc = Text.of(["alpha beta", "gamma"])
	let set = new WordSet("", doc, 2)
	set.build(Infinity)
	let cs = ChangeSet.of({from: 0, to: doc.length, insert: "delta epsilon"}, doc.length)
	set.noteChanges(cs)
	doc = cs.apply(doc)
	expect(set.sync(doc)).toBe(false)
	expect(set.built).toBe(false)
	set.build(Infinity)
	expect(sorted(set.counts)).toEqual(fresh(doc))
})

test("wordChars extend words", () => {
	// "1px" is one word (digits are word characters), and words starting
	// with a digit aren't offered.
	let doc = Text.of(["margin-top: 1px; padding-left"])
	expect([...fresh(doc, "-").keys()]).toEqual(["margin-top", "padding-left"])
	expect([...fresh(doc).keys()]).toEqual(["left", "margin", "padding", "top"])
})

// A minimal view hosting the index plugin, for queries without a DOM.
function setup(doc: string, config = {}) {
	let ext = wordIndex(config) as unknown as [unknown, {create(view: unknown): any}]
	let plugin = ext[1]
	let view: any = {state: EditorState.create({doc, extensions: ext as any})}
	view.plugin = (p: unknown) => p === plugin ? instance : null
	let instance = plugin.create(view)
	let dispatch = (spec: TransactionSpec, notify = true) => {
		let tr = view.state.update(spec)
		view.state = tr.state
		if (notify) instance.update({state: tr.state, docChanged: tr.docChanged, changes: tr.changes})
	}
	let query = (pos = view.state.doc.length, explicit = false) => {
		let r = completeWords(new CompletionContext(view.state, pos, explicit, view)) as CompletionResult | null
		return r
	}
	return {view, instance, dispatch, query}
}

const labels = (r: CompletionResult | null) => r ? r.options.map(o => o.label).sort() : null

test("completes words by prefix, ignoring case, without the word being typed", () => {
	let {query} = setup("Latency latch other lateral\nlat")
	expect(labels(query())).toEqual(["Latency", "latch", "lateral"])
})

test("words near the cursor get a boost, the rest of the file comes from the index", () => {
	let lines = ["farAway"]
	for (let i = 0; i < 500; i++) lines.push("filler text")
	lines.push("fastNearby", "fa")
	let {query} = setup(lines.join("\n"))
	let r = query()!
	let near = r.options.find(o => o.label == "fastNearby")!, far = r.options.find(o => o.label == "farAway")!
	expect(near.boost).toBeGreaterThan(0)
	expect(far.boost ?? 0).toBe(0)
})

test("follows edits through plugin updates", () => {
	let {dispatch, query} = setup("alpha\n" + "filler\n".repeat(300) + "al")
	expect(labels(query())).toEqual(["alpha"])
	dispatch({changes: {from: 0, to: 5, insert: "allot"}})
	expect(labels(query())).toEqual(["allot"])
})

test("an index lagging an update recovers on the next one", () => {
	let s = setup("alpha beta\n" + "filler\n".repeat(300) + "al")
	expect(labels(s.query())).toEqual(["alpha"])
	// Autocomplete queries before this plugin's update runs: the plugin
	// still has the old document.
	let tr = s.view.state.update({changes: {from: 0, insert: "almond "}})
	s.view.state = tr.state
	s.query()
	s.instance.update({state: tr.state, docChanged: true, changes: tr.changes})
	let r = s.query()
	expect(labels(r)).toEqual(["almond", "alpha"])
	let set = s.instance.sets.get("")
	expect(sorted(set.counts)).toEqual(fresh(tr.state.doc))
})

test("no completions without a word unless asked", () => {
	let {query} = setup("alpha beta ")
	expect(query()).toBeNull()
	expect(labels(query(undefined, true))).toEqual(["alpha", "beta"])
})

test("results cut short are queried again", () => {
	let words = Array.from({length: 50}, (_, i) => `item${i}`).join(" ")
	let {query} = setup(words + "\nit", {maxOptions: 10})
	let r = query()!
	expect(r.options.length).toBe(10)
	expect(r.validFor).toBeUndefined()
	let all = setup(words + "\nit").query()!
	expect(all.options.length).toBe(50)
	expect(typeof all.validFor).toBe("function")
	let valid = all.validFor as (text: string) => boolean
	expect(valid("ite")).toBe(true)
	expect(valid("i")).toBe(false)
	expect(valid("it em")).toBe(false)
})

test("big documents index in idle slices and offer nearby words meanwhile", async () => {
	let lines = ["distantWord"]
	for (let i = 0; i < 20000; i++) lines.push(`filler${i % 50} text`)
	lines.push("closeWord di")
	let {query} = setup(lines.join("\n"), {syncIndexLimit: 1000})
	let first = query()!
	expect(labels(first)).toEqual([])
	expect(first.validFor).toBeUndefined()
	for (let i = 0; i < 200 && !labels(query())!.includes("distantWord"); i++) await new Promise(r => setTimeout(r, 20))
	expect(labels(query())).toEqual(["distantWord"])
})
