import {DocInput, Language, language} from "@codemirror/language"
import {type ChangeSet, type EditorState, MapMode, type Text} from "@codemirror/state"
import {NodeProp, type NodeType, type Parser, type PartialParse, Tree, TreeFragment} from "@lezer/common"
import {getStyleTags, highlightTree, type Highlighter} from "@lezer/highlight"

/// Style runs for one line: flat triples of (from, to, classId), with
/// offsets relative to the line start.
export type LineRuns = readonly number[]

const WINDOW_LINES = 128
const WINDOW_LEAD = 48
const MAX_WINDOWS = 24
const MAX_CACHED_LINES = 4000
/// How far beyond the viewport the canonical parse keeps going.
const PARSE_AHEAD = 400_000
/// While scrolling, the canonical parse only keeps this far ahead.
const SCROLL_AHEAD = 30_000
/// Beyond this gap the visible area uses window parses instead of
/// waiting for the canonical parse.
const WINDOW_GAP = 30_000
/// For languages with embedded languages (HTML's scripts and styles, Vue,
/// Markdown code blocks), a window starting mid-file misses the context
/// that switches language (a window inside a <script> body parses it as
/// HTML text). There, the canonical parse is extended to the screen
/// instead, and windows only fill in beyond this gap.
const MIXED_WINDOW_GAP = 400_000
/// Mixed-language parses stop this far past the visible text first,
/// before continuing to the full look-ahead.
const MIXED_STAGE_AHEAD = 3000
/// Time a frame may spend parsing visible text that has no colors yet
/// (see `workVisible`), and the slice budget while it's still missing.
/// Only while the user isn't scrolling or typing; CodeMirror's own parse
/// worker takes slices of up to 100ms.
const VISIBLE_BUDGET = 40
const URGENT_BUDGET = 40
/// Highlighting this far before a partial tree's end may still change
/// when the parse continues.
const STABLE_MARGIN = 2000

interface Window {
	index: number
	/// Identifies the tree its lines' runs came from (< -1).
	source: number
	from: number
	to: number
	parse: PartialParse | null
	tree: Tree | null
	/// While parsing again after edits: the previous tree's fragments.
	fragments: readonly TreeFragment[]
	used: number
}

interface CachedLine {
	from: number
	text: string
	runs: LineRuns
	/// Identifies the tree the runs were computed from. -1 = stale
	/// (kept across an edit until fresh runs are available).
	source: number
}

type Scheduler = (cb: () => void) => void

/// Canonical trees by document, kept when a driver is dropped (the view
/// switched to another state), so showing that document again, as when
/// switching back to an editor tab, needn't parse it again.
const treeCache = new WeakMap<Text, {parser: Parser, tree: Tree, len: number}>()

const defaultScheduler: Scheduler = (() => {
	if (typeof MessageChannel == "undefined") return (cb: () => void) => setTimeout(cb, 0)
	let channel = new MessageChannel(), queue: (() => void)[] = []
	channel.port1.onmessage = () => queue.shift()?.()
	return (cb: () => void) => {
		queue.push(cb)
		channel.port2.postMessage(null)
	}
})()

/// Drives Lezer parsing for highlighting independently of
/// CodeMirror's view, in short time slices. Visible lines get colors
/// from (in order) the canonical incremental parse, a local window
/// parse when the canonical parse is far behind, or runs kept from
/// before the last edit.
export class SyntaxDriver {
	/// Bumped whenever newly available highlighting may change what is
	/// drawn.
	version = 0
	private parser: Parser | null = null
	private doc!: Text
	private tree = Tree.empty
	private treeLen = 0
	/// The document the canonical tree was parsed for, and a counter
	/// bumped on every publish.
	private treeDoc: Text | null = null
	private published = 0
	private treeSource = 1
	private fragments: readonly TreeFragment[] = []
	private parse: PartialParse | null = null
	private windows = new Map<number, Window>()
	private lines = new Map<number, CachedLine>()
	private classIds = new Map<string, number>()
	readonly classes: string[] = []
	private nextSource = 2
	/// `other`: where changes not caused by document edits start (new
	/// parse progress, windows), or -1. The view maps cached data through
	/// edits itself (`RainbowBrackets.mapEdit`).
	private changed: {from: number, to: number, other: number} | null = null
	private editing = false
	private useCounter = 0
	private visibleFrom = 0
	private visibleTo = 0
	private scheduled = false
	private destroyed = false
	/// Time budget per slice in ms; lower while the user is scrolling.
	budget = () => 8
	/// Whether the user is scrolling or typing: then only what's near the
	/// screen is parsed, one slice per frame, and the look-ahead waits
	/// until they pause, leaving the CPU to the fling or keystrokes.
	scrolling = () => false

	constructor(state: EditorState, private highlighter: Highlighter | readonly Highlighter[], private onUpdate: () => void,
				private schedule: Scheduler = defaultScheduler) {
		this.reset(state)
	}

	private reset(state: EditorState) {
		this.parser = state.facet(language)?.parser ?? null
		// LR parsers configured with `wrap` (parseMixed) embed other languages.
		this.mixed = !!(this.parser as {wrappers?: readonly unknown[]} | null)?.wrappers?.length
		this.doc = state.doc
		// A reset can come with a new document (language and text changed
		// in one transaction): keep the visible range inside it.
		this.visibleTo = Math.min(this.visibleTo, this.doc.length)
		this.visibleFrom = Math.min(this.visibleFrom, this.visibleTo)
		this.tree = Tree.empty
		this.treeLen = 0
		this.treeSource = this.nextSource++
		this.fragments = []
		this.parse = null
		this.windows.clear()
		this.lines.clear()
		this.version++
		this.noteChanged(0, this.doc.length)
		this.adoptExisting(state)
		this.kick()
	}

	/// Start from the longest tree already parsed for this document: one
	/// kept from an earlier driver, or the state's language field.
	private adoptExisting(state: EditorState) {
		if (!this.parser) return
		let best: {tree: Tree, len: number} | null = null
		let cached = treeCache.get(this.doc)
		if (cached && cached.parser == this.parser) best = cached
		let field = this.stateTree(state)
		if (field && (!best || field.len > best.len)) best = field
		if (!best || !best.len) return
		this.fragments = TreeFragment.addTree(best.tree, [], best.len < this.doc.length)
		this.publish(best.tree, best.len)
	}

	/// The state's language tree and how far it's parsed, if it's for
	/// this driver's parser.
	private stateTree(state: EditorState): {tree: Tree, len: number} | null {
		if (state.facet(language)?.parser != this.parser) return null
		let field = state.field((Language as any).state, false) as {tree: Tree, context?: {treeLen: number}} | undefined
		if (!field?.tree) return null
		return {tree: field.tree, len: Math.min(field.context?.treeLen ?? field.tree.length, field.tree.length, state.doc.length)}
	}

	setHighlighter(h: Highlighter | readonly Highlighter[]) {
		this.highlighter = h
		this.lines.clear()
		this.treeSource = this.nextSource++
		this.version++
		this.noteChanged(0, this.doc.length)
	}

	get hasLanguage() { return !!this.parser }

	/// The end of the visible text (set by the scene).
	get visibleEnd() { return this.visibleTo }

	/// The latest canonical tree, if it was parsed for `doc` (so it can
	/// be shared with the editor state's language field).
	canonicalTree(doc: Text): {tree: Tree, len: number, id: number, parser: Parser} | null {
		if (this.treeDoc !== doc || !this.parser || !this.treeLen) return null
		return {tree: this.tree, len: this.treeLen, id: this.published, parser: this.parser}
	}

	/// How far beyond the canonical parse the screen may be before window
	/// parses are used.
	private get windowGap() { return this.mixed ? MIXED_WINDOW_GAP : WINDOW_GAP }
	private mixed = false

	update(state: EditorState, changes: ChangeSet | null) {
		let parser = state.facet(language)?.parser ?? null
		if (parser != this.parser) return this.reset(state)
		if (!changes || changes.empty) return
		this.editing = true
		let oldDoc = this.doc
		this.doc = state.doc
		let ranges: {fromA: number, toA: number, fromB: number, toB: number}[] = []
		changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({fromA, toA, fromB, toB}))
		let firstChange = ranges[0].fromA
		if (this.parse) this.takeTree()
		let prevTree = this.tree, prevSource = this.treeSource, prevLen = this.treeLen
		this.fragments = TreeFragment.applyChanges(TreeFragment.addTree(this.tree, this.fragments, true), ranges)
		// The old tree stays valid (and keeps its source id) for the
		// unchanged prefix, so lines above the edit keep their colors.
		this.treeLen = Math.min(this.treeLen, firstChange)
		this.parse = null
		let lastChange = ranges[ranges.length - 1].toA, delta = changes.newLength - changes.length
		let {edited, shifted} = this.mapWindows(ranges, oldDoc.lines == this.doc.lines, delta)
		let sources = new Set([prevSource, ...edited.map(e => e.source)])
		let near = this.mapLines(changes, firstChange, lastChange, sources, shifted)
		if (this.parser) {
			this.visibleTo = Math.min(this.doc.length, changes.mapPos(this.visibleTo, 1))
			this.visibleFrom = Math.min(this.visibleFrom, this.visibleTo)
			// CodeMirror's language field has already reparsed this change
			// (it does in every transaction): use its tree rather than
			// parsing the same text again. Otherwise re-parse the visible
			// part synchronously when that's quick, so typing doesn't
			// flash stale colors.
			// Far beyond the canonical parse, windows color the screen and
			// a few ms of canonical parsing wouldn't reach it.
			let windowed = this.visibleFrom > this.treeLen + this.windowGap
			if (!this.adoptStateTree(state) && !windowed) this.workCanonical(performance.now() + 6, this.visibleTo)
			// Lines near the screen whose tree was parsed again keep their
			// runs where it reused their subtrees (all of them before the
			// edit when the tree is still the old one).
			this.keepReused(near, prevSource, prevTree, prevLen, this.tree, this.treeSource, this.treeLen, 0, delta)
			let end = performance.now() + 6
			for (let {window: w, tree, source} of edited) if (this.workWindow(w, end) && tree && w.from <= firstChange)
				this.keepReused(near, source, tree, w.to - delta, w.tree!, w.source, w.to, w.from, delta)
		}
		this.version++
		this.noteChanged(ranges[0].fromB, this.doc.length)
		this.editing = false
		this.kick()
	}

	/// Map window parses through an edit. Without changes to the line
	/// count (windows are keyed by line), parsed windows after it are
	/// shifted, and the one(s) around it (or still parsing after it) are
	/// parsed again incrementally, from their own trees' fragments: typing
	/// faster than a slow device parses a window must not restart it from
	/// scratch. Otherwise every window from the edit on is dropped.
	/// Returns the windows to parse and the sources of the shifted ones.
	private mapWindows(ranges: readonly {fromA: number, toA: number, fromB: number, toB: number}[], sameLines: boolean, delta: number) {
		let first = ranges[0].fromA, last = ranges[ranges.length - 1].toA
		let edited: {window: Window, tree: Tree | null, source: number}[] = [], shifted = new Set<number>()
		for (let [k, w] of this.windows) {
			if (w.to < first) continue
			let after = w.from > last
			if (!sameLines || !after && (w.from > first || w.to < last)) {
				this.windows.delete(k)
			} else if (after && w.tree) {
				w.from += delta
				w.to += delta
				shifted.add(w.source)
			} else {
				// An unfinished parse restarts from the fragments it started
				// from (finishing its partial tree costs more than it saves).
				let fragments = w.tree ? [new TreeFragment(w.from, w.to, w.tree, -w.from)] : w.fragments
				w.fragments = TreeFragment.applyChanges(fragments, ranges)
				edited.push({window: w, tree: w.tree, source: w.source})
				if (after) w.from += delta
				w.to += delta
				w.tree = null
				w.source = -1 - this.nextSource++
				w.parse = this.parser!.startParse(new DocInput(this.doc), w.fragments, [{from: w.from, to: w.to}])
			}
		}
		return {edited, shifted}
	}

	/// Map cached lines through an edit. Lines after it become stale, and
	/// so do lines before it near the screen from a tree being parsed
	/// again (its parse may restructure text before the edit too: closing
	/// a template string recolors the lines above it). Those lines are
	/// returned with their old source and side, for `keepReused`.
	private mapLines(changes: ChangeSet, firstChange: number, lastChange: number, sources: Set<number>, shifted: Set<number>) {
		let next = new Map<number, CachedLine>(), near: {line: CachedLine, source: number, after: boolean}[] = []
		for (let entry of this.lines.values()) {
			let from = changes.mapPos(entry.from, 1, MapMode.TrackDel)
			if (from == null) continue
			let line = this.doc.lineAt(from)
			if (line.from != from || line.text != entry.text) continue
			let end = entry.from + entry.text.length, unchanged = end < firstChange, after = entry.from >= lastChange
			let isNear = sources.has(entry.source) && entry.from <= this.visibleTo && end >= this.visibleFrom && (unchanged || after)
			let keep = isNear ? false : unchanged || after && shifted.has(entry.source)
			let mapped = {from, text: line.text, runs: entry.runs, source: keep ? entry.source : -1}
			next.set(line.number, mapped)
			if (isNear) near.push({line: mapped, source: entry.source, after})
		}
		this.lines = next
		near.sort((a, b) => a.line.from - b.line.from)
		return near
	}

	/// After an edit, lines from `source` (tree `prev`, of length
	/// `prevLen`, now replaced by `tree`/`treeSource` of length `len`)
	/// whose subtrees the new tree reused keep their runs, so the scene
	/// doesn't highlight the lines around the cursor again on each
	/// keystroke. `offset` is where both trees start in the document.
	private keepReused(lines: readonly {line: CachedLine, source: number, after: boolean}[], source: number,
					   prev: Tree, prevLen: number, tree: Tree, treeSource: number, len: number, offset: number, delta: number) {
		let until = -1, untilAfter = -1
		for (let {line, source: s, after} of lines) {
			if (s != source) continue
			let from = line.from - offset, to = from + line.text.length, d = after ? delta : 0
			if (to + offset > len || to - d + offset > prevLen) continue
			if (after) {
				if (to > untilAfter && (untilAfter = reusedUntil(prev, tree, from, to, d)) < 0) continue
			} else {
				if (to > until && (until = reusedUntil(prev, tree, from, to, 0)) < 0) continue
			}
			line.source = treeSource
		}
	}

	/// Tell the driver which document range is visible (or about to be).
	setVisible(from: number, to: number) {
		if (from == this.visibleFrom && to == this.visibleTo) return
		this.visibleFrom = from
		this.visibleTo = to
		this.kick()
	}

	private kick() {
		if (this.scheduled || this.destroyed || !this.parser) return
		this.scheduled = true
		this.schedule(this.run)
	}

	private run = () => {
		this.scheduled = false
		if (this.destroyed || !this.parser) return
		let scrolling = this.scrolling()
		// Visible text without colors: nothing correct can be drawn
		// until it's parsed, so take longer slices (startup work competing
		// for the thread would otherwise stretch short ones over seconds).
		let budget = !scrolling && this.treeLen < Math.min(this.visibleTo, this.doc.length) ? Math.max(this.budget(), URGENT_BUDGET) : this.budget()
		let end = performance.now() + budget
		let changed = false
		// 1. Visible area far beyond the canonical parse: window parses.
		if (this.visibleFrom > this.treeLen + this.windowGap) changed = this.workWindows(end) || changed
		// 2. The canonical parse, up to the viewport plus look-ahead (just
		// past the screen while scrolling).
		if (performance.now() < end) {
			let target = Math.min(this.doc.length, this.visibleTo + (scrolling ? SCROLL_AHEAD : PARSE_AHEAD))
			if (this.treeLen < target) changed = this.workCanonical(end, target) || changed
		}
		if (changed) {
			this.version++
			this.onUpdate()
		}
		if (!this.needsWork()) return
		if (!scrolling) this.kick()
		else if (this.urgent()) this.kickAfterFrame()
		else this.kickLater(120)
	}

	/// Parse the visible text right away when it has no colors yet and
	/// the user isn't scrolling or typing (a file opened, a tab switched
	/// to). Called by the frame before drawing, so text and colors appear
	/// together, rather than colors waiting for background slices to get
	/// the thread. Only what's on screen is parsed here.
	workVisible() {
		if (!this.parser || this.destroyed || this.scrolling()) return
		let to = Math.min(this.visibleTo, this.doc.length)
		if (this.treeLen >= to || this.visibleFrom > this.treeLen + this.windowGap) return
		if (this.workCanonical(performance.now() + VISIBLE_BUDGET, to)) this.version++
	}

	/// Visible text that isn't parsed yet (by the canonical parse or a window).
	private urgent() {
		let target = Math.min(this.doc.length, this.visibleTo + SCROLL_AHEAD)
		if (this.visibleFrom > this.treeLen + this.windowGap) return this.windowsNeeded().some(i => !this.windows.get(i)?.tree)
		return this.treeLen < target
	}

	private kickAfterFrame() {
		if (this.scheduled || this.destroyed || !this.parser) return
		this.scheduled = true
		requestAnimationFrame(() => setTimeout(this.run, 0))
	}

	private kickLater(ms: number) {
		if (this.scheduled || this.destroyed || !this.parser) return
		this.scheduled = true
		setTimeout(this.run, ms)
	}

	private needsWork() {
		let target = Math.min(this.doc.length, this.visibleTo + PARSE_AHEAD)
		if (this.treeLen < target) return true
		return this.visibleFrom > this.treeLen + this.windowGap && this.windowsNeeded().some(i => !this.windows.get(i)?.tree)
	}

	/// Take the state's language tree as the canonical tree when it was
	/// parsed for this document and covers the visible text.
	private adoptStateTree(state: EditorState) {
		let found = this.stateTree(state)
		if (!found) return false
		let {tree, len} = found
		if (len < Math.min(this.visibleTo, this.doc.length) || len <= this.treeLen) return false
		this.parse = null
		this.fragments = TreeFragment.addTree(tree, [], len < this.doc.length)
		this.publish(tree, len)
		return true
	}

	/// Advance the canonical parse. Publishes a partial tree as soon as
	/// it covers the visible range. Returns true if the tree changed.
	private workCanonical(end: number, target: number): boolean {
		if (this.mixed) return this.workMixed(end, target)
		let parser = this.parser!
		if (!this.parse) {
			this.parse = parser.startParse(new DocInput(this.doc), this.fragments)
		}
		for (;;) {
			let done = this.parse.advance()
			if (done) {
				this.publish(done, this.doc.length)
				this.fragments = TreeFragment.addTree(done)
				this.parse = null
				return true
			}
			let pos = this.parse.parsedPos
			if (pos >= target) {
				if (pos <= this.treeLen) return false
				this.takeTree()
				return true
			}
			if (performance.now() > end) {
				// Publish a partial tree when it newly covers visible text,
				// or after a lot of background progress.
				let gain = pos - this.treeLen
				if (gain > 0 && (this.treeLen < this.visibleTo && pos > this.visibleFrom || gain > 100_000)) {
					this.takeTree()
					return true
				}
				return false
			}
		}
	}

	/// Mixed-language parses (parseMixed) report no progress until their
	/// outer parse is done, so no partial tree can be taken along the
	/// way. Instead the parse is stopped at a target and run to the end:
	/// first just past the visible text, then to the full look-ahead.
	/// Each restart reuses the previous tree as fragments.
	private workMixed(end: number, target: number): boolean {
		let stage = this.treeLen < this.visibleTo ? Math.min(target, this.visibleTo + MIXED_STAGE_AHEAD) : target
		if (!this.parse) {
			if (this.treeLen >= stage) return false
			this.parse = this.parser!.startParse(new DocInput(this.doc), this.fragments)
		}
		let parse = this.parse
		if (stage < this.doc.length && (parse.stoppedAt == null || parse.stoppedAt > stage)) parse.stopAt(stage)
		for (;;) {
			let done = parse.advance()
			if (done) {
				let len = Math.min(parse.stoppedAt ?? this.doc.length, this.doc.length)
				this.parse = null
				if (len <= this.treeLen) return false
				this.publish(done, len)
				this.fragments = TreeFragment.addTree(done, this.fragments, len < this.doc.length)
				return true
			}
			if (performance.now() > end) return false
		}
	}

	private takeTree() {
		let parse = this.parse
		if (!parse) return
		if (this.mixed) {
			// No partial tree to take (see workMixed); the fragments keep
			// what earlier stages parsed.
			this.parse = null
			return
		}
		let pos = parse.parsedPos
		if (pos < this.treeLen) return
		if (parse.stoppedAt == null || parse.stoppedAt > pos) parse.stopAt(pos)
		let tree: Tree | null
		while (!(tree = parse.advance())) {}
		this.publish(tree, pos)
		this.fragments = TreeFragment.addTree(tree, this.fragments, true)
		this.parse = null
	}

	/// Install a new canonical tree. Highlighting well before the old
	/// tree's end can't change, so cached runs there are carried over to
	/// the new tree and only the frontier is reported as changed.
	private publish(tree: Tree, len: number) {
		let oldSource = this.treeSource
		let stable = Math.max(0, Math.min(this.treeLen, len) - STABLE_MARGIN)
		this.tree = tree
		this.treeLen = len
		this.treeDoc = this.doc
		this.published++
		this.treeSource = this.nextSource++
		for (let e of this.lines.values())
			if (e.source == oldSource && e.from + e.text.length < stable) e.source = this.treeSource
		this.noteChanged(stable, len)
	}

	private noteChanged(from: number, to: number) {
		let c = this.changed
		let other = this.editing ? -1 : from
		if (!c) this.changed = {from, to, other}
		else {
			c.from = Math.min(c.from, from)
			c.to = Math.max(c.to, to)
			if (other >= 0) c.other = c.other < 0 ? other : Math.min(c.other, other)
		}
	}

	/// The document range whose highlighting may have changed since the
	/// last call (null if none).
	takeChanged() {
		let c = this.changed
		this.changed = null
		return c
	}

	private windowsNeeded() {
		let first = this.doc.lineAt(this.visibleFrom).number, last = this.doc.lineAt(this.visibleTo).number
		let out: number[] = []
		for (let i = Math.floor((first - 1) / WINDOW_LINES); i <= Math.floor((last - 1) / WINDOW_LINES); i++) out.push(i)
		return out
	}

	private workWindows(end: number) {
		let changed = false
		for (let index of this.windowsNeeded()) {
			let w = this.windows.get(index)
			if (!w) {
				let firstLine = Math.max(1, index * WINDOW_LINES + 1 - WINDOW_LEAD)
				let lastLine = Math.min(this.doc.lines, (index + 1) * WINDOW_LINES)
				let from = this.doc.line(firstLine).from, to = this.doc.line(lastLine).to
				w = {index, source: -1 - this.nextSource++, from, to, parse: null, tree: null, fragments: [], used: ++this.useCounter}
				w.parse = this.parser!.startParse(new DocInput(this.doc), [], [{from, to}])
				this.evictWindows()
				this.windows.set(index, w)
			}
			w.used = ++this.useCounter
			if (w.tree) continue
			if (this.workWindow(w, end)) changed = true
			else return changed
		}
		return changed
	}

	/// Advance a window's parse until `end`. Returns true when it's done.
	private workWindow(w: Window, end: number) {
		while (w.parse) {
			let done = w.parse.advance()
			if (done) {
				w.tree = done
				w.parse = null
				w.fragments = []
				this.noteChanged(w.from, w.to)
				return true
			}
			if (performance.now() > end) return false
		}
		return !!w.tree
	}

	private evictWindows() {
		if (this.windows.size < MAX_WINDOWS) return
		let oldest: Window | null = null
		for (let w of this.windows.values()) if (!oldest || w.used < oldest.used) oldest = w
		if (oldest) this.windows.delete(oldest.index)
	}

	private classId(cls: string) {
		let id = this.classIds.get(cls)
		if (id == null) {
			id = this.classes.length
			this.classes.push(cls)
			this.classIds.set(cls, id)
		}
		return id
	}

	/// Get style runs for lines `first`..`last` (1-based, inclusive).
	/// `out(lineNumber, runs, exact)` gets null runs for lines without
	/// any highlighting yet; `exact` is false for provisional or stale runs.
	/// `trim` drops cached lines far from these (pass false for lines
	/// away from the screen, e.g. sticky headers, so the visible lines'
	/// runs stay cached).
	runsFor(first: number, last: number, out: (line: number, runs: LineRuns | null, exact: boolean) => void, trim = true) {
		let doc = this.doc
		if (!this.parser) {
			for (let n = first; n <= last; n++) out(n, null, true)
			return
		}
		let n = first
		while (n <= last) {
			let line = doc.line(n)
			let cached = this.lines.get(n)
			let source: {tree: Tree, id: number, to: number, offset: number} | null = null
			if (line.to <= this.treeLen) {
				source = {tree: this.tree, id: this.treeSource, to: this.treeLen, offset: 0}
			} else {
				let w = this.windows.get(Math.floor((n - 1) / WINDOW_LINES))
				// Trees from ranged parses start at the range, not at 0.
				if (w?.tree && line.from >= w.from && line.to <= w.to) source = {tree: w.tree, id: w.source, to: w.to, offset: w.from}
			}
			if (source && current(cached, line, source.id)) {
				out(n, cached!.runs, source.id >= 0)
				n++
				continue
			}
			if (!source) {
				let stale = cached && cached.text === line.text ? cached.runs : null
				out(n, stale, false)
				n++
				continue
			}
			// Highlight a batch of lines from the same source in one pass,
			// up to the next line still cached (after an edit, most are).
			let end = n, endLine = line
			while (end < last) {
				let next = doc.line(end + 1)
				if (next.to > source.to || current(this.lines.get(end + 1), next, source.id)) break
				end++
				endLine = next
			}
			this.highlightBatch(source.tree, source.id, source.offset, line.from, endLine.to, n)
			for (let k = n; k <= end; k++) out(k, this.lines.get(k)!.runs, source.id >= 0)
			n = end + 1
		}
		if (trim) this.trimLines(first, last)
	}

	private highlightBatch(tree: Tree, sourceId: number, offset: number, from: number, to: number, firstLine: number) {
		let doc = this.doc
		let lineNo = firstLine, line = doc.line(lineNo)
		let runs: number[] = []
		let flush = () => {
			this.lines.set(lineNo, {from: line.from, text: line.text, runs, source: sourceId})
		}
		let {tree: sub, at, highlighters} = highlightRoot(tree, this.highlighter, from - offset, to - offset)
		offset += at
		highlightTree(sub, highlighters, (start, end, cls) => {
			let id = this.classId(cls)
			start += offset
			end += offset
			for (;;) {
				while (start > line.to) {
					flush()
					runs = []
					line = doc.line(++lineNo)
				}
				let stop = Math.min(end, line.to)
				if (stop > start) runs.push(start - line.from, stop - line.from, id)
				if (end <= line.to) break
				start = line.to + 1
			}
		}, from - offset, to - offset)
		for (;;) {
			flush()
			if (line.to >= to || lineNo >= doc.lines) break
			runs = []
			line = doc.line(++lineNo)
		}
	}

	private trimLines(first: number, last: number) {
		if (this.lines.size <= MAX_CACHED_LINES) return
		let keepFrom = first - MAX_CACHED_LINES / 4, keepTo = last + MAX_CACHED_LINES / 4
		for (let k of this.lines.keys()) if (k < keepFrom || k > keepTo) this.lines.delete(k)
	}

	/// Parse state for diagnostics and benchmarks.
	get progress() {
		return {treeLen: this.treeLen, docLength: this.doc.length, windows: this.windows.size, parsing: !!this.parse}
	}

	destroy() {
		this.destroyed = true
		if (this.parser && this.treeDoc === this.doc && this.treeLen) {
			let kept = treeCache.get(this.doc)
			if (!kept || kept.parser != this.parser || kept.len < this.treeLen)
				treeCache.set(this.doc, {parser: this.parser, tree: this.tree, len: this.treeLen})
		}
	}
}

function current(cached: CachedLine | undefined, line: {from: number, text: string}, source: number) {
	return cached != null && cached.source == source && cached.from == line.from && cached.text === line.text
}

/// Whether `from..to` (a range of `next`) is highlighted exactly as
/// `from - delta..to - delta` of `prev`. Lezer's incremental parse
/// reuses unchanged subtrees by identity, and a node's highlighting
/// depends only on its content and its named ancestors' types (style
/// rules match parent paths, never siblings). So when `next` holds, around
/// the range, a subtree of `prev` at the shifted position under the same
/// named ancestors, the range's colors are unchanged. Returns the end of
/// that subtree in `next` (every line before it is covered too), or -1.
/// Mixed parses qualify too: `parseMixed` mounts inner trees by mutating
/// nodes, but never nodes it reused.
export function reusedUntil(prev: Tree, next: Tree, from: number, to: number, delta: number): number {
	let path: NodeType[] = [], node = next, at = 0
	for (;;) {
		if (!node.type.isAnonymous) path.push(node.type)
		let inner: Tree | null = null
		for (let i = 0; i < node.children.length; i++) {
			let child = node.children[i], start = at + node.positions[i]
			if (start > from) break
			if (start + child.length < to) continue
			// Buffers are never reused; mounted trees aren't children.
			if (child instanceof Tree && !child.prop(NodeProp.mounted)) {
				if (heldAt(prev, child, start - delta, path)) return start + child.length
				inner = child
				at = start
			}
			break
		}
		if (!inner) return -1
		node = inner
	}
}

/// Whether `prev` holds `target` at `pos` under the named ancestors `path`.
function heldAt(prev: Tree, target: Tree, pos: number, path: readonly NodeType[]) {
	let node = prev, at = 0, depth = 0, end = pos + target.length
	for (;;) {
		if (!node.type.isAnonymous && path[depth++] !== node.type) return false
		let inner: Tree | null = null
		for (let i = 0; i < node.children.length; i++) {
			let child = node.children[i], start = at + node.positions[i]
			if (start > pos) break
			if (child === target) return start == pos && depth == path.length
			if (start + child.length < end || !(child instanceof Tree)) continue
			inner = child
			at = start
			break
		}
		if (!inner) return false
		node = inner
	}
}

/// Where to start highlighting `from..to` of `tree`: the smallest
/// anonymous chunk around the range, and its offset. `highlightTree`
/// walks the top node's children from the first one to reach a range,
/// and Lezer balances long repeats (a file's statements) into anonymous
/// chunks that its cursor flattens: in a 120k-line file that was ~10k
/// steps (2.5ms) per call, so every edit (the visible lines, sticky
/// headers) paid it. Chunks nest a few levels deep, so descending costs
/// next to nothing, and their nodes keep every named ancestor but the
/// top node, which only scopes the highlighters (applied here) and
/// carries no style of its own (checked).
export function highlightRoot(tree: Tree, highlighter: Highlighter | readonly Highlighter[], from: number, to: number) {
	let all: readonly Highlighter[] = Array.isArray(highlighter) ? highlighter : [highlighter as Highlighter]
	let highlighters = all.filter(h => !h.scope || h.scope(tree.type))
	let at = 0, sub = tree
	if (!tree.prop(NodeProp.mounted) && !getStyleTags(tree.topNode)) {
		descend: for (;;) {
			for (let i = 0; i < sub.children.length; i++) {
				let child = sub.children[i], start = at + sub.positions[i]
				if (start > from) break
				if (child instanceof Tree && child.type.isAnonymous && start + child.length >= to && !child.prop(NodeProp.mounted)) {
					sub = child
					at = start
					continue descend
				}
			}
			break
		}
	}
	return {tree: sub, at, highlighters}
}
