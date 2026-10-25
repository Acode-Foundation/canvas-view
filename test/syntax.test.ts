import {expect, test} from "bun:test"
import {EditorState} from "@codemirror/state"
import {html} from "@codemirror/lang-html"
import {javascript} from "@codemirror/lang-javascript"
import {classHighlighter} from "@lezer/highlight"
import {SyntaxDriver} from "../src/view/syntax"

// A large HTML file whose <script> sits at the very end, viewed from
// the end: the window parses used for far-away text would read the
// script body as HTML text.
test("embedded script at the end of a large HTML file is highlighted", () => {
	let body = Array.from({length: 3200}, (_, i) => `    <div class="row r${i}"><span>item ${i}</span></div>`).join("\n")
	let fns = Array.from({length: 300}, (_, i) => `  function f${i}(x) { return x + ${i} }`).join("\n")
	let script = `<script>\n${fns}\n  const total = items.reduce((a, b) => a + b, 0)\n  function show() { return total }\n</script>`
	let doc = `<!doctype html>\n<html>\n<body>\n${body}\n${script}\n</body>\n</html>\n`
	let state = EditorState.create({doc, extensions: html()})
	let queue: (() => void)[] = []
	let driver = new SyntaxDriver(state, classHighlighter, () => {}, cb => queue.push(cb))
	let line = state.doc.lineAt(doc.indexOf("const total"))
	driver.setVisible(state.doc.line(line.number - 30).from, state.doc.line(Math.min(state.doc.lines, line.number + 10)).to)
	// The first colors shown for the line must already be JavaScript's.
	let classes: string[] | null = null
	for (let i = 0; i < 1000 && queue.length && !classes; i++) {
		queue.shift()!()
		driver.runsFor(line.number, line.number, (_n, runs) => {
			if (runs) classes = Array.from({length: runs.length / 3}, (_, k) => driver.classes[runs[k * 3 + 2]])
		})
	}
	expect(classes!).toContain("tok-keyword")
	expect(classes!.some(c => c.includes("tok-variableName"))).toBe(true)
})

// Switching editor tabs replaces the view's state: showing a document
// again starts from the tree parsed for it before.
test("a document shown again reuses its parse", () => {
	let doc = Array.from({length: 5000}, (_, i) => `function f${i}(x) { return x * ${i} }`).join("\n")
	let state = EditorState.create({doc, extensions: javascript()})
	let queue: (() => void)[] = []
	let first = new SyntaxDriver(state, classHighlighter, () => {}, cb => queue.push(cb))
	first.setVisible(0, 2000)
	for (let i = 0; i < 1000 && queue.length; i++) queue.shift()!()
	expect(first.progress.treeLen).toBe(doc.length)
	first.destroy()
	let again = new SyntaxDriver(EditorState.create({doc: state.doc, extensions: javascript()}), classHighlighter, () => {}, () => {})
	expect(again.progress.treeLen).toBe(doc.length)
	let other = new SyntaxDriver(EditorState.create({doc: doc + "\n", extensions: javascript()}), classHighlighter, () => {}, () => {})
	expect(other.progress.treeLen).toBeLessThan(doc.length)
})

// Highlighting starts from the smallest anonymous chunk around a range
// (`highlightRoot`): it must give exactly what highlighting from the
// top gives, in fresh and incrementally reparsed trees.
test("highlighting from a chunk matches highlighting from the top", async () => {
	let {highlightRoot} = await import("../src/view/syntax")
	let {makeFixture} = await import("../demo/fixtures")
	let {ensureSyntaxTree} = await import("@codemirror/language")
	let {highlightTree} = await import("@lezer/highlight")
	let {css} = await import("@codemirror/lang-css")
	let collect = (tree: any, from: number, to: number, chunked: boolean) => {
		let out: string[] = []
		if (chunked) {
			let r = highlightRoot(tree, classHighlighter, from, to)
			highlightTree(r.tree, r.highlighters, (a, b, c) => out.push(`${a + r.at}-${b + r.at}:${c}`), from - r.at, to - r.at)
		} else {
			highlightTree(tree, classHighlighter, (a, b, c) => out.push(`${a}-${b}:${c}`), from, to)
		}
		return out.join(" ")
	}
	let cases: [string, any][] = [["js", javascript()], ["deep", javascript()], ["unicode", javascript()], ["rtl", javascript()],
		["html", html()], ["css", css()]]
	let descended = 0
	for (let [kind, lang] of cases) {
		let doc = kind == "css" ? Array.from({length: 3000}, (_, i) => `.c${i} > a:hover { color: #${(i * 7919 % 0xffffff).toString(16)}; margin: ${i}px }`).join("\n")
			: makeFixture(kind as any, 6000)
		let state = EditorState.create({doc, extensions: lang})
		for (let round = 0; round < 3; round++) {
			let tree = ensureSyntaxTree(state, state.doc.length, 1e9)!
			let lines = state.doc.lines
			for (let k = 0; k < 120; k++) {
				let a = 1 + (k * 7919 + round * 104729) % lines, b = Math.min(lines, a + (k % 7) * 9)
				let from = state.doc.line(a).from, to = state.doc.line(b).to
				expect(collect(tree, from, to, true)).toBe(collect(tree, from, to, false))
				if (highlightRoot(tree, classHighlighter, from, to).at > 0) descended++
			}
			// Edit, so the next round's tree comes from an incremental parse.
			let at = state.doc.line(Math.floor(lines * (0.3 + round * 0.2))).from
			state = state.update({changes: {from: at, insert: round == 1 ? "{\n" : "x = 1\n"}}).state
		}
	}
	// The fast path is taken.
	expect(descended).toBeGreaterThan(1000)
})

// @lezer/common < 1.5.4 over-stated the look-ahead of the chunks that
// balance a file's statements, so incremental parses never reused them
// and an edit's reparse cost grew with its position in the document
// (369ms at line 100k of a 4MB file). Guards against that returning.
test("an edit deep in a large file reparses as fast as one near the top", async () => {
	let {makeFixture} = await import("../demo/fixtures")
	let {TreeFragment} = await import("@lezer/common")
	let parser = javascript().language.parser
	let text = makeFixture("js", 40000), tree = parser.parse(text)
	let lineEnd = (n: number) => { let p = 0; for (let i = 1; i < n; i++) p = text.indexOf("\n", p) + 1; return text.indexOf("\n", p) }
	let reparse = (pos: number) => {
		let next = text.slice(0, pos) + "x" + text.slice(pos)
		let fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{fromA: pos, toA: pos, fromB: pos, toB: pos + 1}])
		let times: number[] = []
		for (let i = 0; i < 5; i++) {
			let t = performance.now(), parse = parser.startParse(next, fragments)
			parse.stopAt(pos + 3000)
			while (!parse.advance()) {}
			times.push(performance.now() - t)
		}
		return times.sort((a, b) => a - b)[2]
	}
	let early = reparse(lineEnd(12)), deep = reparse(lineEnd(35000))
	expect(deep).toBeLessThan(Math.max(5, early * 5))
})

// After an edit, lines whose subtrees the new tree reused keep their
// highlighting (`reusedUntil`) and rainbow brackets (`mapEdit`): both
// must match a fresh pass over the new tree, for random edits that open
// and close comments, strings, templates, tags and brackets. The
// documents are shorter than the brackets' look-behind, so a fresh scan
// is exact.
test("lines kept across edits match fresh highlighting and brackets", async () => {
	let {reusedUntil} = await import("../src/view/syntax")
	let {RainbowBrackets} = await import("../src/view/brackets")
	let {makeFixture} = await import("../demo/fixtures")
	let {ensureSyntaxTree, syntaxTree} = await import("@codemirror/language")
	let {highlightTree} = await import("@lezer/highlight")
	let {parseMixed} = await import("@lezer/common")
	let {cssLanguage} = await import("@codemirror/lang-css")
	let {javascriptLanguage} = await import("@codemirror/lang-javascript")
	// Like Acode's JSDoc highlighting: another language mounted in block comments.
	let jsdoc = javascriptLanguage.configure({wrap: parseMixed(node => node.name == "BlockComment" ? {parser: cssLanguage.parser} : null)})
	let runs = (tree: any, from: number, to: number) => {
		let out: string[] = []
		highlightTree(tree, classHighlighter, (a, b, c) => out.push(`${Math.max(a, from) - from}-${Math.min(b, to) - from}:${c}`), from, to)
		return out.join(" ")
	}
	let inserts = ["c", "(", ")", "{", "}", "[", "]", "/*", "*/", "/** a {", "*/ x {", "`", "${", "'", "\"", "//", "\n", "x = (", "<div>", "</script>", ";", "})"]
	let colors = [1, 2, 3, 4, 5, 6]
	for (let seed of [11, 12345]) for (let [ext, kind] of [[javascript(), "js"], [html(), "html"], [jsdoc, "js"]] as const) {
		let rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
		let state = EditorState.create({doc: makeFixture(kind, 500), extensions: ext})
		ensureSyntaxTree(state, state.doc.length, 1e9)
		let mapped = new RainbowBrackets(colors)
		let kept = 0, confirmed = 0
		for (let i = 0; i < 200; i++) {
			let doc = state.doc, t0 = syntaxTree(state)
			let at = 30 + rnd(doc.lines - 100), last = at + 60
			for (let n = at - 20; n <= last; n++) mapped.lineBrackets(doc, t0, t0.length, n)
			// Runs as cached before the edit (mounts are set by mutation).
			let before = new Map<number, string>()
			for (let n = at - 20; n <= Math.min(doc.lines, last + 10); n++) before.set(doc.line(n).from, runs(t0, doc.line(n).from, doc.line(n).to))
			let line = doc.line(at), pos = line.from + rnd(line.length + 1)
			let del = rnd(4) == 0 ? Math.min(rnd(6), doc.length - pos) : 0
			let text = rnd(5) == 0 && del ? "" : inserts[rnd(inserts.length)]
			let tr = state.update({changes: {from: pos, to: pos + del, insert: text}})
			state = tr.state
			ensureSyntaxTree(state, state.doc.length, 1e9)
			let t1 = syntaxTree(state), delta = text.length - del, until = -1
			mapped.mapEdit(tr.changes, doc, state.doc, t1, t1.length)
			let held = (mapped as any).pending
			let fresh = new RainbowBrackets(colors)
			for (let n = 1; n <= state.doc.lines; n++) fresh.lineBrackets(state.doc, t1, t1.length, n)
			for (let n = at - 20; n <= Math.min(state.doc.lines, last); n++)
				expect(mapped.lineBrackets(state.doc, t1, t1.length, n)).toEqual(fresh.lineBrackets(state.doc, t1, t1.length, n))
			if (held && (mapped as any).brackets.get(held.from) === held.brackets[0]) confirmed++
			for (let n = at - 20, until = -1; n < at; n++) {
				let l = state.doc.line(n)
				if (l.to > until && (until = reusedUntil(t0, t1, l.from, l.to, 0)) < 0) continue
				kept++
				expect(runs(t1, l.from, l.to)).toBe(before.get(l.from)!)
			}
			for (let n = state.doc.lineAt(pos + text.length).number + 1; n <= Math.min(state.doc.lines, last); n++) {
				let l = state.doc.line(n)
				if (l.to > until && (until = reusedUntil(t0, t1, l.from, l.to, delta)) < 0) continue
				kept++
				expect(runs(t1, l.from, l.to)).toBe(before.get(l.from - delta)!)
			}
		}
		expect(state.doc.length).toBeLessThan(24_000)
		expect(kept).toBeGreaterThan(2000)
		expect(confirmed).toBeGreaterThan(50)
	}
}, 60000)

// Deep in a large file the screen is colored by window parses. Typing
// there shifts the windows after the edit and reparses the edited one
// incrementally: the colors must be what fresh windows give. (Lines
// within 2000 chars of a partial tree's end are provisional by design,
// so only lines of the same kind of source are compared.)
test("window parses mapped through edits match fresh ones", async () => {
	let {makeFixture} = await import("../demo/fixtures")
	let state = EditorState.create({doc: makeFixture("js", 120000), extensions: javascript()})
	let at = 110000
	let visible = (s: EditorState) => [s.doc.line(at - 30).from, s.doc.line(at + 40).to] as const
	let queues = new Map<SyntaxDriver, (() => void)[]>()
	let fresh = (s: EditorState) => {
		let queue: (() => void)[] = []
		let d = new SyntaxDriver(s, classHighlighter, () => {}, cb => queue.push(cb))
		queues.set(d, queue)
		// Enough for the windows, little for the canonical parse after them.
		d.budget = () => 60
		d.setVisible(...visible(s))
		queue.shift()!()
		return d
	}
	let named = (d: SyntaxDriver, runs: readonly number[] | null) => JSON.stringify(runs?.map((v, k) => k % 3 == 2 ? d.classes[v] : v))
	let source = (d: SyntaxDriver, n: number) => {
		let s = (d as any).lines.get(n)?.source ?? -1
		return s < -1 ? "window" : s >= 0 ? "tree" : "stale"
	}
	let driver = fresh(state), driverQueue = queues.get(driver)!
	expect(driver.progress.windows).toBeGreaterThan(0)
	let seed = 5, rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
	let inserts = ["c", "(", ")", "{", "}", "/*", "*/", "`", "'", " = ", "\n"]
	let compared: Record<string, number> = {window: 0, tree: 0}
	for (let i = 0; i < 90; i++) {
		let line = state.doc.line(at - 20 + rnd(50)), pos = line.from + rnd(line.length + 1)
		let tr = state.update({changes: {from: pos, insert: inserts[rnd(inserts.length)]}})
		state = tr.state
		// Some edits run on a fast clock, so the window parse they start is
		// cut off and the next edit restarts it from what it had.
		let now = performance.now
		if (i % 3) performance.now = () => now.call(performance) * 1000
		driver.update(state, tr.changes)
		performance.now = now
		if (i % 3) continue
		// One background slice finishes the windows (more would bring the
		// canonical parse to the screen).
		driverQueue.shift()?.()
		let ref = fresh(state), mine = new Map<number, string>()
		let [from, to] = visible(state)
		let first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number
		let stable = Math.min(driver.progress.treeLen, ref.progress.treeLen) - 2000
		driver.runsFor(first, last, (n, runs) => mine.set(n, named(driver, runs)))
		ref.runsFor(first, last, (n, runs) => {
			let kind = source(ref, n)
			if (kind == "stale" || kind != source(driver, n) || kind == "tree" && state.doc.line(n).to > stable) return
			compared[kind]++
			expect(mine.get(n)).toBe(named(ref, runs))
		})
	}
	expect(compared.window).toBeGreaterThan(500)
}, 60000)
