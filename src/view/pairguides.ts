import type {Text} from "@codemirror/state"
import {indentWidth} from "./sticky"

/// A bracket pair spanning lines (`bracketPairGuides`). `open` and
/// `close` are document positions; -1 when that bracket is further
/// than `LIMIT` lines from the window (or not parsed yet).
export interface BracketPair {
	open: number
	close: number
	openLine: number
	closeLine: number
	/// Nesting depth of the pair (its rainbow color index, modulo).
	depth: number
	/// Column of the guide: the smaller indentation of the two lines.
	col: number
}

/// How many lines outside the window brackets are looked for. This
/// bounds the work after an edit that leaves a bracket unclosed (every
/// pair below is then unclosed until the scan's end): a pair whose other
/// end is further away is still drawn, from the end that's known.
const LIMIT = 1500

const isOpen = (ch: number) => ch == 40 || ch == 91 || ch == 123

/// The bracket pairs spanning more than one line that cross document
/// lines `first`..`last`, from the rainbow bracket scan (tree brackets
/// outside strings and comments). The pairs open above the window are
/// found walking back from its first line until its depth is accounted
/// for; those closing below it, walking on until they close.
export function bracketPairs(doc: Text, first: number, last: number, tabSize: number,
	lineBrackets: (n: number) => readonly number[] | null, depthAt: (n: number) => number | null): BracketPair[] {
	let pairs: BracketPair[] = []
	let depth = depthAt(first)
	if (depth == null) return pairs
	// Openers above the window that are still open at its start.
	let above: {pos: number, line: number}[] = [], need = depth, closes = 0
	for (let n = first - 1; n >= Math.max(1, first - LIMIT) && need > 0; n--) {
		let br = lineBrackets(n)
		if (!br) break
		let line = doc.line(n)
		for (let i = br.length - 2; i >= 0 && need > 0; i -= 2) {
			if (!isOpen(line.text.charCodeAt(br[i]))) closes++
			else if (closes) closes--
			else { above.push({pos: line.from + br[i], line: n}); need-- }
		}
	}
	above.reverse()
	let stack: {pos: number, line: number}[] = []
	for (let i = 0; i < need; i++) stack.push({pos: -1, line: 0})
	for (let o of above) stack.push(o)
	// Stack entries opened at or before `last`: once past the window
	// with none left, nothing more crosses it.
	let crossing = stack.length
	let indent = (n: number) => Math.max(0, indentWidth(doc.line(n).text, tabSize))
	let add = (o: {pos: number, line: number}, close: number, closeLine: number, d: number) => {
		if (o.pos >= 0 && closeLine == o.line) return
		if (o.pos < 0 && close < 0) return
		let col = o.pos < 0 ? indent(closeLine) : close < 0 ? indent(o.line) : Math.min(indent(o.line), indent(closeLine))
		pairs.push({open: o.pos, close, openLine: o.line, closeLine, depth: d, col})
	}
	let end = Math.min(doc.lines, last + LIMIT)
	for (let n = first; n <= end; n++) {
		if (n > last && !crossing) break
		let br = lineBrackets(n)
		if (!br) break
		let line = doc.line(n)
		for (let i = 0; i < br.length; i += 2) {
			let pos = line.from + br[i]
			if (isOpen(line.text.charCodeAt(br[i]))) {
				stack.push({pos, line: n})
				if (n <= last) crossing++
			} else {
				let o = stack.pop()
				if (!o) continue
				if (o.pos < 0 || o.line <= last) crossing--
				if (n >= first) add(o, pos, n, stack.length)
			}
		}
	}
	// Still open where the scan stopped: they run past the window.
	for (let d = 0; d < stack.length; d++) {
		let o = stack[d]
		if (o.pos >= 0 && o.line <= last) add(o, -1, 0, d)
	}
	return pairs
}
