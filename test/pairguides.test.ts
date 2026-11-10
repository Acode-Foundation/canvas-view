import {expect, test} from "bun:test"
import {EditorState} from "@codemirror/state"
import {ensureSyntaxTree} from "@codemirror/language"
import {javascript} from "@codemirror/lang-javascript"
import {RainbowBrackets} from "../src/view/brackets"
import {bracketPairs} from "../src/view/pairguides"

function pairs(doc: string, first: number, last: number) {
	let state = EditorState.create({doc, extensions: javascript()})
	let tree = ensureSyntaxTree(state, state.doc.length, 5000)!
	let r = new RainbowBrackets([1, 2, 3])
	let found = bracketPairs(state.doc, first, last, 4,
		n => r.lineBrackets(state.doc, tree, tree.length, n), n => r.depthAt(state.doc, tree, tree.length, n))
	let lineOf = (pos: number) => pos < 0 ? 0 : state.doc.lineAt(pos).number
	return found.map(p => ({open: lineOf(p.open), close: lineOf(p.close), depth: p.depth, col: p.col}))
		.sort((a, b) => a.open - b.open || a.depth - b.depth)
}

const code = [
	"function f(a) {",       // 1
	"    if (a) {",          // 2
	"        g([",           // 3
	"            1,",        // 4
	"        ])",            // 5
	"    }",                 // 6
	"    let s = \"{ ( [\"", // 7: brackets in strings don't count
	"    // } ) ]",          // 8: nor in comments
	"    return h(a, b)",    // 9: same-line pairs aren't guides
	"}",                     // 10
].join("\n")

test("finds pairs spanning lines, with depth and column", () => {
	expect(pairs(code, 1, 10)).toEqual([
		{open: 1, close: 10, depth: 0, col: 0},
		{open: 2, close: 6, depth: 1, col: 4},
		{open: 3, close: 5, depth: 2, col: 8},
		{open: 3, close: 5, depth: 3, col: 8}
	])
})

test("pairs opened above the window and closed below it", () => {
	// Window lines 4-4: inside all four pairs.
	expect(pairs(code, 4, 4)).toEqual([
		{open: 1, close: 10, depth: 0, col: 0},
		{open: 2, close: 6, depth: 1, col: 4},
		{open: 3, close: 5, depth: 2, col: 8},
		{open: 3, close: 5, depth: 3, col: 8}
	])
	// Window 7-8: only the function's pair crosses it.
	expect(pairs(code, 7, 8)).toEqual([{open: 1, close: 10, depth: 0, col: 0}])
})

test("an unclosed bracket runs to the end of the scan", () => {
	let doc = "if (x) {\n    a()\n    b()\n"
	expect(pairs(doc, 1, 3)).toEqual([{open: 1, close: 0, depth: 0, col: 0}])
})

test("the column is the smaller indentation of the two lines", () => {
	let doc = "    call(\n  arg\n)"
	expect(pairs(doc, 1, 3)).toEqual([{open: 1, close: 3, depth: 0, col: 0}])
})
