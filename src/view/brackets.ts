import type {ChangeDesc, Text} from "@codemirror/state"
import type {Tree} from "@lezer/common"
import type {PackedColor} from "../core/color"
import {reusedUntil} from "./syntax"

export const darkRainbow = ["#e5c07b", "#c678dd", "#56b6c2", "#61afef", "#98c379", "#d19a66"]
export const lightRainbow = ["#795e26", "#af00db", "#005cc5", "#008000", "#b15c00", "#267f99"]

/// How far back a scan may start when nothing nearer is known; brackets
/// open before that are assumed balanced (like Acode's plugin).
const LOOK_BEHIND = 24_000
/// How much text before an edit may be bracketed differently after it
/// (like the syntax driver's margin before a partial tree's end).
const REPARSE_BEFORE = 2000
/// How many lines after an edit `mapEdit` looks at.
const MAX_PENDING = 1000

/// Per-line rainbow bracket colors from the syntax tree: bracket tokens
/// outside strings and comments, colored by nesting depth. Depths at
/// line starts are cached, so a frame only scans lines it hasn't seen,
/// and an edit only invalidates the lines after it.
export class RainbowBrackets {
	/// Bracket depth at the start of line n.
	private depth = new Map<number, number>()
	/// Brackets per line: flat [offset, colorIndex] pairs.
	private brackets = new Map<number, number[]>()
	private tree: Tree | null = null
	private skipTypes = new Map<number, boolean>()
	/// Lines after the last edit kept from before it, until a scan
	/// confirms them: depths at the starts of lines `from`.., and the
	/// brackets of all but the last of those lines.
	private pending: {from: number, depths: number[], brackets: number[][]} | null = null

	constructor(readonly colors: PackedColor[]) {}

	/// Forget everything from line `n` on (new highlighting there).
	invalidateFrom(n: number) {
		for (let k of this.depth.keys()) if (k > n) this.depth.delete(k)
		for (let k of this.brackets.keys()) if (k >= n) this.brackets.delete(k)
		if (this.pending && this.pending.from + this.pending.depths.length > n) this.pending = null
	}

	/// Map the cache through an edit (`tree` is the new canonical tree).
	/// Lines before the edit keep their brackets. After it, the brackets
	/// of lines whose subtrees the new tree reused are the same tokens, so
	/// they only differ when the edit changed the depth (an unbalanced
	/// bracket typed): they're kept pending, and the first scan reaching
	/// them confirms them if it arrives with their old depth, so typing
	/// doesn't rescan every line below the cursor.
	mapEdit(changes: ChangeDesc, oldDoc: Text, doc: Text, tree: Tree | null, treeLen: number) {
		let firstA = -1, lastA = 0
		changes.iterChangedRanges((fromA, toA) => {
			if (firstA < 0) firstA = fromA
			lastA = toA
		})
		if (firstA < 0) return
		// The parse may restructure some text before an edit too (an
		// unterminated string or a deleted brace changes how the lines
		// above recover): those lines are scanned again.
		let first = oldDoc.lineAt(Math.max(0, firstA - REPARSE_BEFORE)).number
		// What's kept is consistent with the new tree from here on (the
		// next edit's reuse checks compare with it).
		let prev = this.tree, oldDepth = this.depth, oldBrackets = this.brackets
		this.tree = tree
		this.depth = new Map()
		this.brackets = new Map()
		for (let [k, d] of oldDepth) if (k <= first) this.depth.set(k, d)
		for (let [k, b] of oldBrackets) if (k < first) this.brackets.set(k, b)
		this.pending = null
		if (!prev || !tree || prev == tree) return
		// Lines before the edit keep their brackets while they're reused
		// (each line's depth follows from the ones above).
		for (let k = first, edited = oldDoc.lineAt(firstA).number, until = -1; k < edited; k++) {
			let line = oldDoc.line(k), list = oldBrackets.get(k)
			if (!list || !oldDepth.has(k + 1) || line.to > treeLen ||
				line.to > until && (until = reusedUntil(prev, tree, line.from, line.to, 0)) < 0) break
			this.brackets.set(k, list)
			this.depth.set(k + 1, oldDepth.get(k + 1)!)
		}
		// The lines right after the edit (its block) were usually parsed
		// again: the kept run starts at the first reused line.
		let after = oldDoc.lineAt(lastA).number + 1, delta = changes.newLength - changes.length
		let depths: number[] = [], brackets: number[][] = [], until = -1, start = -1
		for (let k = after; k <= oldDoc.lines && k < after + MAX_PENDING && oldDepth.has(k); k++) {
			let line = oldDoc.line(k), list = oldBrackets.get(k)
			let from = line.from + delta, to = line.to + delta
			if (list && to <= treeLen && (to <= until || (until = reusedUntil(prev, tree, from, to, delta)) >= 0)) {
				if (start < 0) start = k
				depths.push(oldDepth.get(k)!)
				brackets.push(list)
			} else if (start >= 0) {
				depths.push(oldDepth.get(k)!)
				break
			}
		}
		if (start >= 0) this.pending = {from: start + doc.lines - oldDoc.lines, depths, brackets}
	}

	/// The brackets on line `n`, scanning the tree if needed. Null when the
	/// tree doesn't cover the line yet.
	lineBrackets(doc: Text, tree: Tree | null, treeLen: number, n: number): readonly number[] | null {
		if (!tree) return null
		if (tree !== this.tree) {
			// A new tree only changes colors where it differs, but which
			// lines that is isn't known here: the scene invalidates the
			// reported range through `invalidateFrom`.
			this.tree = tree
		}
		let found = this.brackets.get(n)
		if (found) return found
		let line = doc.line(n)
		if (line.to > treeLen) return null
		if (this.brackets.size > 6000) this.trim(n)
		this.scan(doc, tree, n)
		return this.brackets.get(n) ?? null
	}

	private trim(n: number) {
		for (let k of this.brackets.keys()) if (Math.abs(k - n) > 2000) this.brackets.delete(k)
		for (let k of this.depth.keys()) if (Math.abs(k - n) > 2000 && k % 256) this.depth.delete(k)
	}

	/// Scan from the nearest line with a known depth (or a look-behind
	/// start) through line `target` (plus a little more).
	private scan(doc: Text, tree: Tree, target: number) {
		let start = target
		while (start > 1 && !this.depth.has(start) && doc.line(target).from - doc.line(start - 1).from < LOOK_BEHIND) start--
		let depth = this.depth.get(start) ?? 0
		let last = Math.min(doc.lines, target + 200)
		let from = doc.line(start).from, to = doc.line(last).to
		let lineNo = start, lineEnd = doc.line(start).to, lineFrom = from, out: number[] = []
		this.depth.set(start, depth)
		let pending = this.pending, stop = false
		if (pending && start >= pending.from) pending = this.pending = null
		let advance = (pos: number) => {
			while (pos > lineEnd && lineNo < last) {
				this.brackets.set(lineNo, out)
				out = []
				lineNo++
				let l = doc.line(lineNo)
				lineFrom = l.from
				lineEnd = l.to
				this.depth.set(lineNo, depth)
				if (pending && lineNo == pending.from) {
					this.pending = null
					if (depth == pending.depths[0]) {
						// Arrived with the old depth: the kept lines are current.
						pending.depths.forEach((d, i) => this.depth.set(lineNo + i, d))
						pending.brackets.forEach((b, i) => this.brackets.set(lineNo + i, b))
						if (target < lineNo + pending.brackets.length) { stop = true; return }
					}
					pending = null
				}
			}
		}
		let n = this.colors.length
		tree.iterate({
			from, to,
			enter: node => {
				if (stop) return false
				let type = node.type
				let skip = this.skipTypes.get(type.id)
				if (skip == null) {
					let name = type.name.toLowerCase()
					this.skipTypes.set(type.id, skip = /string|comment|regexp|regex/.test(name))
				}
				if (skip) return false
				let name = type.name
				if (name.length != 1 || node.to - node.from != 1) return
				let open = name == "(" || name == "[" || name == "{"
				if (!open && name != ")" && name != "]" && name != "}") return
				advance(node.from)
				if (open) { out.push(node.from - lineFrom, depth % n); depth++ }
				else { depth = Math.max(0, depth - 1); out.push(node.from - lineFrom, depth % n) }
			}
		})
		if (stop) return
		advance(to + 1)
		if (!stop) this.brackets.set(lineNo, out)
	}
}
