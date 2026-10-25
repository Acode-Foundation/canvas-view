// Sticky scroll, like VS Code's: the header lines of the scopes around
// the top of the view (a function, a class, an `if` block...) stay
// pinned at the top while their bodies scroll under them.
//
// Scopes are the syntax tree's fold ranges (`foldNodeProp`, what
// CodeMirror's fold gutter folds), so they need no language support
// of their own; languages without them (legacy stream modes, plain
// text) use indentation, like VS Code's fallback and Acode's
// indentation folding. This module only decides which lines stick;
// the view draws them (see `CanvasView.buildSticky`).

import {foldNodeProp, language, StreamLanguage, type Language} from "@codemirror/language"
import type {EditorState} from "@codemirror/state"
import type {NodeIterator, NodeSet, SyntaxNode, Tree} from "@lezer/common"

/// A scope: the document line its header is on, and the line it ends
/// on (for indentation scopes only compared with the line asked about:
/// that line, or a later one).
export interface Scope {
	header: number
	end: number
}

/// What sticky scroll shows for a scroll position: the header lines
/// (first lines of their visual lines), outermost first, and the slot
/// of the last one when it's being pushed up by the end of its scope
/// (-1 if none).
export interface StickyHeaders {
	lines: readonly number[]
	pushed: number
}

/// What the scope finder needs to know about rows.
export interface StickyRows {
	/// First document line of the visual line at a 0-based row.
	lineAtRow(row: number): number
	/// Last document line of the visual line starting at `n` (a fold
	/// joins lines).
	lastLine(n: number): number
	/// The last row.
	lastRow(): number
}

/// Nesting levels considered.
const MAX_DEPTH = 32
/// Cached chains (lines) before the cache is dropped.
const MAX_CHAINS = 4096
/// Indentation scopes: lines scanned upward for a header (a line with
/// none that close counts as top level), and downward for the next
/// non-blank line.
const INDENT_SCAN = 1500
const BLANK_SCAN = 200
const MAX_PARENTS = 100_000

const noScopes: readonly Scope[] = []
const noHeaders: StickyHeaders = {lines: [], pushed: -1}

const syntaxFoldCache = new WeakMap<Language, boolean>()

/// Whether a language's syntax tree has fold ranges. Stream languages
/// (CodeMirror 5 modes) produce token trees without structure.
function syntaxFolds(lang: Language | null) {
	if (!lang || lang instanceof StreamLanguage) return false
	let found = syntaxFoldCache.get(lang)
	if (found == null) {
		let set = (lang.parser as {nodeSet?: NodeSet}).nodeSet
		// A parser without a node set (custom): try its trees.
		found = !set || set.types.some(t => t.prop(foldNodeProp) != null)
		syntaxFoldCache.set(lang, found)
	}
	return found
}

/// Columns of a line's indentation, or -1 for a blank line.
function indentWidth(text: string, tabSize: number) {
	let cols = 0
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i)
		if (c == 32) cols++
		else if (c == 9) cols += tabSize - cols % tabSize
		else return cols
	}
	return -1
}

/// A header line that starts with a closing bracket (`) {` after a
/// parameter list spanning lines) says little about its scope.
const continuation = /^\s*[)\]]/
const lone = /^\s*\{\s*$/
const statementEnd = /[;{}]\s*$/

/// Finds the scopes around a line, with caches that live until the
/// document, tree or tab size change. Queries are cheap: a syntax
/// chain is one `resolveStack` walk (a few dozen nodes), an
/// indentation chain a short upward scan with memoized jumps.
export class ScopeFinder {
	private chains = new Map<number, readonly Scope[]>()
	/// Indentation mode: the header of each line (0: none), memoized.
	private parents = new Map<number, number>()
	private key: unknown[] = []
	private state!: EditorState
	private tree: Tree | null = null
	private treeLen = 0
	private tabSize = 4
	private syntax = false
	/// Last `headers` result and what it was computed from.
	private last: {key: unknown[], value: StickyHeaders} = {key: [], value: noHeaders}

	/// Point the finder at a state and syntax tree (`treeLen`: how much
	/// of the document the tree covers). Caches are dropped when the
	/// document, tree or tab size changed.
	sync(state: EditorState, tree: Tree | null, treeLen: number, tabSize: number) {
		this.state = state
		let lang = state.facet(language)
		let syntax = syntaxFolds(lang)
		let key = [state.doc, syntax ? tree : null, syntax ? treeLen : 0, tabSize, lang]
		if (key.some((v, i) => v !== this.key[i])) {
			this.key = key
			this.chains.clear()
			this.parents.clear()
			this.tree = tree
			this.treeLen = Math.min(treeLen, tree?.length ?? 0)
			this.tabSize = tabSize
			this.syntax = syntax
		}
	}

	/// Version of the scope data (changes when caches are dropped).
	get version() { return this.key }

	/// The scopes containing line `n` (header above it, end at or after
	/// it), outermost first, one per header line.
	chain(n: number): readonly Scope[] {
		let found = this.chains.get(n)
		if (found) return found
		if (this.chains.size > MAX_CHAINS) this.chains.clear()
		found = this.syntax ? this.syntaxChain(n) : this.indentChain(n)
		if (!found.length) found = noScopes
		this.chains.set(n, found)
		return found
	}

	private syntaxChain(n: number): Scope[] {
		let tree = this.tree, state = this.state, doc = state.doc
		let line = doc.line(n)
		if (!tree || line.from > this.treeLen) return []
		let out: Scope[] = []
		for (let iter: NodeIterator | null = tree.resolveStack(line.from, 1); iter; iter = iter.next) {
			let node = iter.node
			if (node.from >= line.from) continue
			let prop = node.type.prop(foldNodeProp)
			// Comments fold, but a pinned `/**` says nothing.
			if (!prop || node.name.includes("Comment")) continue
			let range = prop(node, state)
			if (!range || range.to <= range.from || range.from > doc.length) continue
			let header = doc.lineAt(range.from).number
			if (header >= n) continue
			// Nodes running into the unparsed rest of the document may end anywhere after.
			let end = node.to >= this.treeLen && this.treeLen < doc.length ? doc.lines : doc.lineAt(Math.min(range.to, doc.length)).number
			if (end < n) continue
			out.push({header: this.signatureLine(node, header), end})
			if (out.length == MAX_DEPTH) break
		}
		out.reverse()
		return dedupe(out)
	}

	/// The line a scope's header is drawn from. Usually the line where
	/// its fold range starts, but `) {` after a parameter list spanning
	/// lines goes up to where the list starts (`function f(`), and an
	/// Allman-style lone `{` to the line before it.
	private signatureLine(node: SyntaxNode, header: number) {
		let doc = this.state.doc, line = doc.line(header)
		if (lone.test(line.text) && header > 1) {
			let prev = doc.line(header - 1)
			if (prev.text.trim() && !statementEnd.test(prev.text)) line = prev
		}
		// Only siblings ending on the header line belong to the signature
		// (not a statement before a bare block).
		for (let s = node.prevSibling; s && continuation.test(line.text); s = s.prevSibling) {
			if (s.to < line.from) break
			let start = doc.lineAt(s.from)
			if (start.number < line.number) line = start
		}
		return line.number
	}

	private indent(n: number) { return indentWidth(this.state.doc.line(n).text, this.tabSize) }

	/// Indentation scopes: a non-blank line's header is the nearest line
	/// above with less indentation. Blank lines belong to the block of
	/// the next non-blank line.
	private indentChain(n: number): Scope[] {
		let doc = this.state.doc
		let ind = this.indent(n), next = this.nextIndent(n)
		let header = ind < 0 ? (next <= 0 ? 0 : this.parentBelow(n, next)) : this.parentOf(n)
		let out: Scope[] = []
		for (let k = header; k > 0 && out.length < MAX_DEPTH; k = this.parentOf(k)) {
			// The block ends at `n` when the next non-blank line is no
			// deeper than its header (trailing blank lines don't count).
			out.push({header: k, end: next <= this.indent(k) ? n : Math.min(doc.lines, n + 1)})
		}
		return out.reverse()
	}

	/// Indentation of the next non-blank line after `n` (-1: none
	/// close, or the end of the document).
	private nextIndent(n: number) {
		let doc = this.state.doc
		for (let k = n + 1, end = Math.min(doc.lines, n + BLANK_SCAN); k <= end; k++) {
			let i = this.indent(k)
			if (i >= 0) return i
		}
		return -1
	}

	private parentOf(n: number) {
		let found = this.parents.get(n)
		if (found == null) {
			let ind = this.indent(n)
			found = ind <= 0 ? 0 : this.parentBelow(n, ind)
			if (this.parents.size > MAX_PARENTS) this.parents.clear()
			this.parents.set(n, found)
		}
		return found
	}

	/// The nearest non-blank line above `n` indented less than `ind`.
	/// Lines indented as much or more jump to their own (memoized)
	/// header, and lines indented exactly `ind` on the way get the same
	/// header, so scanning a long flat block happens once.
	private parentBelow(n: number, ind: number) {
		let doc = this.state.doc, same: number[] = []
		let k = n - 1, found = 0, steps = 0
		for (; k >= 1 && steps < INDENT_SCAN; steps++) {
			let i = indentWidth(doc.line(k).text, this.tabSize)
			if (i < 0) { k--; continue }
			if (i < ind) { found = k; break }
			if (i == ind) same.push(k)
			let p = this.parents.get(k)
			k = p ?? k - 1
		}
		// Given up before finding one: the answer isn't known for them.
		if (found || k < 1) for (let s of same) if (!this.parents.has(s)) this.parents.set(s, found)
		return found
	}

	/// The sticky headers for a scroll position, VS Code's rule: slot
	/// `i` (a line tall, from the top) shows the scope at depth `i`
	/// whose header has scrolled above the slot's bottom and whose body
	/// reaches below it. When a scope's last line passes under the slot,
	/// its header is pushed up with that line, and no deeper slot shows.
	///
	/// `probe` is the row under the bottom of slot 0; slot `i` looks at
	/// row `probe + i` (rows are all a line tall). The result is cached
	/// until the probe row or the scopes change, so a scroll frame that
	/// stays within a row costs nothing.
	headers(rows: StickyRows, probe: number, maxLines: number, rowsVersion: unknown): StickyHeaders {
		let key = [probe, maxLines, rowsVersion, ...this.key]
		let last = this.last
		if (key.length == last.key.length && key.every((v, i) => v === last.key[i])) return last.value
		let lines: number[] = [], scopes: Scope[] = [], pushed = -1
		let lastRow = rows.lastRow()
		let lineAt = (r: number) => r < 0 ? 0 : rows.lineAtRow(Math.min(r, lastRow))
		let matches = (chain: readonly Scope[], i: number) => {
			if (chain.length <= i) return false
			for (let j = 0; j < i; j++) if (chain[j].header != scopes[j].header) return false
			return true
		}
		let below = lineAt(probe - 1)
		for (let i = 0; i < maxLines; i++) {
			let r = probe + i, at = lineAt(r), above = below
			below = at
			// The line above the probe ends a scope at this depth: its
			// header is pushed up with it.
			if (above && above != at) {
				let prev = this.chain(above)
				if (matches(prev, i) && prev[i].end <= rows.lastLine(above)) {
					scopes.push(prev[i])
					pushed = i
					break
				}
			}
			let chain = this.chain(at)
			if (!matches(chain, i)) break
			scopes.push(chain[i])
		}
		for (let s of scopes) lines.push(s.header)
		let prev = last.value
		// Same lines as before: keep the object, so the view keeps its drawing.
		let same = prev.lines.length == lines.length && prev.lines.every((l, i) => l == lines[i])
		let value: StickyHeaders = !lines.length ? noHeaders : same && prev.pushed == pushed ? prev : {lines: same ? prev.lines : lines, pushed}
		this.last = {key, value}
		return value
	}
}

/// One scope per header line (`foo(function() {` opens two), keeping
/// the later end.
function dedupe(scopes: Scope[]) {
	let out: Scope[] = []
	for (let s of scopes) {
		let prev = out[out.length - 1]
		if (prev && prev.header >= s.header) prev.end = Math.max(prev.end, s.end)
		else out.push(s)
	}
	return out
}
