import {expect, test} from "bun:test"
import {DocInput} from "@codemirror/language"
import {Text} from "@codemirror/state"
import {htmlLanguage} from "@codemirror/lang-html"
import {javascriptLanguage} from "@codemirror/lang-javascript"
import {NodeProp, type NodeSet, type Parser, Tree, TreeBuffer, TreeFragment} from "@lezer/common"
import {highlightTree, classHighlighter} from "@lezer/highlight"
import {nestedParser, setFingerprint, TreeDecoder, TreeEncoder} from "../src/core/treecodec"

function parse(parser: Parser, doc: Text, fragments: readonly TreeFragment[] = [], stop?: number) {
	let p = parser.startParse(new DocInput(doc), fragments)
	if (stop != null) p.stopAt(stop)
	let tree: Tree | null
	while (!(tree = p.advance())) {}
	return tree
}

function ctx(parser: Parser, doc: Text) {
	let root = (parser as unknown as {nodeSet: NodeSet}).nodeSet, fp = setFingerprint(root)
	return {set: (f: string) => f == fp ? root : null, mount: nestedParser(new DocInput(doc))}
}

function rootSet(parser: Parser) { return (parser as unknown as {nodeSet: NodeSet}).nodeSet }

/// Structural equality, mounts included (their parsers by identity).
function same(a: Tree | TreeBuffer, b: Tree | TreeBuffer, path = "root"): void {
	if (a instanceof TreeBuffer || b instanceof TreeBuffer) {
		expect(b instanceof TreeBuffer && a instanceof TreeBuffer, path).toBe(true)
		let x = a as TreeBuffer, y = b as TreeBuffer
		expect(y.length, path).toBe(x.length)
		expect(y.set, path).toBe(x.set)
		expect(Array.from(y.buffer), path).toEqual(Array.from(x.buffer))
		return
	}
	expect(b.type, path).toBe(a.type)
	expect(b.length, path).toBe(a.length)
	expect(b.positions, path).toEqual(a.positions)
	let props = (t: Tree) => t.propValues.filter(([, v]) => typeof v == "number").sort((p, q) => +p[0] - +q[0])
	expect(props(b), path).toEqual(props(a))
	let ma = a.prop(NodeProp.mounted), mb = b.prop(NodeProp.mounted)
	expect(!!mb, path + " mounted").toBe(!!ma)
	if (ma && mb) {
		expect(mb.parser, path + " mount parser").toBe(ma.parser)
		expect(mb.overlay, path).toEqual(ma.overlay)
		expect(mb.bracketed, path).toBe(ma.bracketed)
		same(ma.tree, mb.tree, path + ">mount")
	}
	expect(b.children.length, path).toBe(a.children.length)
	for (let i = 0; i < a.children.length; i++) same(a.children[i], b.children[i], path + "/" + i)
}

function colors(tree: Tree) {
	let out: string[] = []
	highlightTree(tree, classHighlighter, (from, to, cls) => out.push(from + "-" + to + cls))
	return out.join(" ")
}

/// Send `tree` through an encoder/decoder pair (structured-clone-like:
/// the arrays are copied).
function send(enc: TreeEncoder, dec: TreeDecoder, tree: Tree, parser: Parser, doc: Text) {
	let e = enc.encode(tree, rootSet(parser))
	let copy = {data: e.data.slice(), buffer: e.buffer.slice(), sets: e.sets.slice(), released: e.released.slice()}
	return {tree: dec.decode(copy, parser, ctx(parser, doc)), size: e.data.length + e.buffer.length}
}

const js = Array.from({length: 800}, (_, i) =>
	`/** Doc ${i} */\nfunction f${i}(a, b) {\n  const s = \`v\${a + ${i}}\`\n  return [a, b, "x${i}"].map(x => x * 2) // c\n}`).join("\n")

const htmlDoc = `<!doctype html>\n<html>\n<head>\n<style>\nbody { color: red }\n.a > .b { margin: 0 }\n</style>\n</head>\n<body>\n` +
	Array.from({length: 400}, (_, i) => `<div class="r${i}" style="color: blue; width: ${i}px" onclick="go(${i})"><span>item ${i}</span></div>`).join("\n") +
	`\n<script>\n${js.slice(0, 4000)}\n</script>\n<script type="module">import {a} from "./b.js"; a()</script>\n</body>\n</html>\n`

test("JavaScript trees are copied exactly", () => {
	let doc = Text.of(js.split("\n")), parser = javascriptLanguage.parser
	let tree = parse(parser, doc)
	let got = send(new TreeEncoder(), new TreeDecoder(), tree, parser, doc).tree
	same(tree, got)
	expect(colors(got)).toBe(colors(tree))
})

test("HTML trees with nested CSS and JavaScript are copied with the receiver's nested parsers", () => {
	let doc = Text.of(htmlDoc.split("\n")), parser = htmlLanguage.parser
	let tree = parse(parser, doc)
	let mounts = 0
	tree.iterate({enter: n => { if (n.tree?.prop(NodeProp.mounted)) mounts++ }})
	expect(mounts).toBeGreaterThanOrEqual(800)
	let got = send(new TreeEncoder(), new TreeDecoder(), tree, parser, doc).tree
	same(tree, got)
	expect(colors(got)).toBe(colors(tree))
})

test("a stopped mixed parse keeps where it stopped", () => {
	let doc = Text.of(htmlDoc.split("\n")), parser = htmlLanguage.parser
	let stop = htmlDoc.indexOf("<script>") + 300
	let tree = parse(parser, doc, [], stop)
	let got = send(new TreeEncoder(), new TreeDecoder(), tree, parser, doc).tree
	same(tree, got)
	// Reparsing from the copy reuses what reparsing from the original does.
	let full = parse(parser, doc, TreeFragment.addTree(got, [], true))
	same(parse(parser, doc, TreeFragment.addTree(tree, [], true)), full)
	expect(colors(full)).toBe(colors(parse(parser, doc)))
})

test("after edits only new nodes are sent, and reparses reuse decoded trees", () => {
	for (let [source, parser] of [[js, javascriptLanguage.parser], [htmlDoc, htmlLanguage.parser]] as const) {
		let doc = Text.of(source.split("\n"))
		let enc = new TreeEncoder(), dec = new TreeDecoder()
		let tree = parse(parser, doc)
		let first = send(enc, dec, tree, parser, doc)
		let local = first.tree
		for (let round = 0; round < 6; round++) {
			let at = Math.floor(source.length * (0.1 + round * 0.13))
			let insert = round % 2 ? "x" : "\n"
			let next = doc.replace(at, at, Text.of(insert.split("\n")))
			let ranges = [{fromA: at, toA: at, fromB: at, toB: at + insert.length}]
			// The sender reparses its tree; the receiver its copy of it.
			tree = parse(parser, next, TreeFragment.applyChanges(TreeFragment.addTree(tree), ranges))
			let sent = send(enc, dec, tree, parser, next)
			expect(sent.size).toBeLessThan(first.size / 4)
			same(tree, sent.tree)
			local = parse(parser, next, TreeFragment.applyChanges(TreeFragment.addTree(local), ranges))
			same(local, sent.tree)
			doc = next
		}
	}
})

test("a tree sent one way comes back by reference", () => {
	let doc = Text.of(htmlDoc.split("\n")), parser = htmlLanguage.parser
	let tree = parse(parser, doc)
	// Main side seeds the worker side with its tree.
	let seedEnc = new TreeEncoder(), workerDec = new TreeDecoder()
	let seeded = send(seedEnc, workerDec, tree, parser, doc).tree
	let workerEnc = new TreeEncoder(), mainDec = new TreeDecoder()
	workerEnc.adopt(workerDec)
	mainDec.adopt(seedEnc)
	let back = workerEnc.encode(seeded, rootSet(parser))
	expect(back.data.length).toBe(2)
	expect(mainDec.decode(back, parser, ctx(parser, doc))).toBe(tree)
})

test("records that don't fit are refused without leaving anything behind", () => {
	let doc = Text.of(htmlDoc.split("\n")), parser = htmlLanguage.parser
	let tree = parse(parser, doc)
	let e = new TreeEncoder().encode(tree, rootSet(parser))
	let dec = new TreeDecoder()
	// The other side's root language isn't this one.
	expect(() => dec.decode(e, javascriptLanguage.parser, ctx(javascriptLanguage.parser, doc))).toThrow()
	// Its nested parsers aren't found.
	expect(() => dec.decode(e, parser, {...ctx(parser, doc), mount: () => null})).toThrow()
	// Truncated.
	expect(() => dec.decode({...e, data: e.data.subarray(0, e.data.length >> 1)}, parser, ctx(parser, doc))).toThrow()
	expect([...dec.known()].length).toBe(0)
})

test("what the sender may still reuse isn't released", () => {
	let doc = Text.of(htmlDoc.split("\n")), parser = htmlLanguage.parser
	let a = parse(parser, doc, [], 20000), b = parse(parser, doc)
	let enc = new TreeEncoder(), dec = new TreeDecoder()
	let first = send(enc, dec, a, parser, doc)
	// A tree that shares nothing with `a`, while `a` is still kept.
	let e = enc.encode(b, rootSet(parser), [a])
	expect(e.released).toEqual([])
	dec.decode(e, parser, ctx(parser, doc))
	// Back to `a`: all by reference.
	let back = enc.encode(a, rootSet(parser), [b])
	expect(back.data.length).toBe(2)
	expect(dec.decode(back, parser, ctx(parser, doc))).toBe(first.tree)
	// Not kept: released.
	expect(enc.encode(b, rootSet(parser)).released.length).toBeGreaterThan(0)
})
