import {expect, test} from "bun:test"
import {EditorState} from "@codemirror/state"
import {ensureSyntaxTree, StreamLanguage} from "@codemirror/language"
import {html} from "@codemirror/lang-html"
import {javascript} from "@codemirror/lang-javascript"
import {ScopeFinder, type StickyRows} from "../src/view/sticky"

function finder(doc: string, extensions: any = javascript()) {
	let state = EditorState.create({doc, extensions})
	let tree = ensureSyntaxTree(state, state.doc.length, 5000)
	let f = new ScopeFinder()
	f.sync(state, tree, tree?.length ?? 0, 4)
	let headers = (n: number) => f.chain(n).map(s => s.header)
	return {state, f, headers}
}

/// Rows without wrapping or folds: row r is line r + 1.
function identityRows(lines: number): StickyRows {
	return {lineAtRow: r => Math.max(1, Math.min(lines, r + 1)), lastLine: n => n, lastRow: () => lines - 1}
}

const js = `function outer(a) {
  if (a) {
    for (const x of a) {
      log(x)
    }
  } else {
    other()
  }
  return a
}
const after = 1`

test("syntax scopes enclose a line, outermost first", () => {
	let {f, headers} = finder(js)
	expect(headers(1)).toEqual([])
	expect(headers(4)).toEqual([1, 2, 3])
	// The closing line still belongs to its scope.
	expect(headers(5)).toEqual([1, 2, 3])
	expect(f.chain(5)[2].end).toBe(5)
	// `} else {` ends the if block and opens the else block.
	expect(headers(6)).toEqual([1, 2])
	expect(headers(7)).toEqual([1, 6])
	expect(headers(10)).toEqual([1])
	expect(headers(11)).toEqual([])
})

test("a parameter list spanning lines sticks from its start", () => {
	let {headers} = finder(`function f(\n  a,\n  b\n) {\n  body()\n}\n`)
	expect(headers(5)).toEqual([1])
})

test("one scope per header line", () => {
	let {headers} = finder(`describe("x", function () {\n  it("y", () => {\n    check()\n  })\n})\n`)
	expect(headers(3)).toEqual([1, 2])
})

test("comments are not scopes", () => {
	let {headers} = finder(`/**\n * doc\n * more\n */\nfunction f() {\n  x()\n}\n`)
	expect(headers(3)).toEqual([])
	expect(headers(6)).toEqual([5])
})

test("html with an embedded script", () => {
	let doc = `<section>\n  <script>\n    function f() {\n      go()\n    }\n  </script>\n</section>\n`
	let {headers} = finder(doc, html())
	expect(headers(4)).toEqual([1, 2, 3])
})

test("indentation scopes for languages without syntax folds", () => {
	let plain = StreamLanguage.define({token: s => { s.skipToEnd(); return null }})
	let doc = "def f():\n    a = 1\n\n    if a:\n        b\n    c\nd\n"
	let {f, headers} = finder(doc, plain)
	expect(headers(2)).toEqual([1])
	// A blank line belongs to the block of the next non-blank line.
	expect(headers(3)).toEqual([1])
	expect(headers(5)).toEqual([1, 4])
	expect(f.chain(5)[1].end).toBe(5)
	expect(f.chain(5)[0].end).toBeGreaterThan(5)
	expect(f.chain(6)[0].end).toBe(6)
	expect(headers(7)).toEqual([])
})

test("headers follow VS Code's slots and push rule", () => {
	let {f} = finder(js)
	let rows = identityRows(11)
	// Slot 0 probes row 3 (line 4), slot 1 row 4, slot 2 row 5 (line
	// 6), right below the for loop's last line: that header is pushed.
	expect(f.headers(rows, 3, 5, 0)).toEqual({lines: [1, 2, 3], pushed: 2})
	expect(f.headers(rows, 3, 2, 0)).toEqual({lines: [1, 2], pushed: -1})
	expect(f.headers(rows, 4, 5, 0)).toEqual({lines: [1, 2], pushed: -1})
	// `} else {` (line 6) ends the if block: pushed, then replaced by
	// the else block.
	expect(f.headers(rows, 5, 5, 0)).toEqual({lines: [1, 2], pushed: 1})
	expect(f.headers(rows, 6, 5, 0)).toEqual({lines: [1, 6], pushed: -1})
	expect(f.headers(rows, 7, 5, 0)).toEqual({lines: [1, 6], pushed: 1})
	expect(f.headers(rows, 9, 5, 0)).toEqual({lines: [1], pushed: -1})
	expect(f.headers(rows, 10, 5, 0)).toEqual({lines: [1], pushed: 0})
	expect(f.headers(rows, 11, 5, 0).lines).toEqual([])
	// The cap.
	expect(f.headers(rows, 3, 1, 0)).toEqual({lines: [1], pushed: -1})
})

test("unchanged headers keep their object", () => {
	let {f} = finder(js)
	let rows = identityRows(11)
	let a = f.headers(rows, 8, 5, 0), b = f.headers(rows, 9, 5, 0)
	expect(b).toBe(a)
})
