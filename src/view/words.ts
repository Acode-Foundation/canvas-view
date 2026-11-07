import type {Completion, CompletionContext, CompletionResult} from "@codemirror/autocomplete"
import {type ChangeSet, EditorState, type Extension, Facet, type Text} from "@codemirror/state"
import {type EditorView, ViewPlugin, type ViewUpdate} from "@codemirror/view"

// Word completion from an incremental index of the document's words.
//
// CodeMirror's completeAnyWord caches word lists per Text node, but only
// for nodes with fewer than 2000 distinct words. In a big file the nodes
// above the leaves aren't cached, so every query merges their lists again
// and returns every distinct word (20k in a 4MB JS file), which
// autocomplete then filters on each key: ~35ms per query on a Helio
// G35-class phone (WebView 80) against ~2ms here.
//
// Here each wordChars set keeps a count per word for one document (`base`)
// plus the changes since (`pending`, composed per update). A query brings
// it up to date by recounting only the changed lines, ranks words from the
// lines around the cursor first, and takes the rest from a sorted list by
// prefix. The first full scan runs in idle slices, started by the first
// query, so a view that never asks for completions pays nothing.

/// Options for [`wordIndex`](#wordIndex) and [`wordCompletion`](#wordCompletion).
export interface WordCompletionConfig {
	/// Most completions returned by one query (default 200). When more
	/// match, the result isn't reused for longer input (no `validFor`),
	/// so the next keystroke queries again.
	maxOptions?: number
	/// Lines around the cursor whose words are offered first, with a
	/// boost (default 200, half above and half below).
	nearbyLines?: number
	/// Shortest word offered (default 2).
	minLength?: number
	/// Documents up to this many characters are indexed synchronously on
	/// the first query (default 100,000). Larger ones in idle slices,
	/// with only nearby words offered until done.
	syncIndexLimit?: number
}

const wordConfig = Facet.define<WordCompletionConfig, Required<WordCompletionConfig>>({
	combine(values) {
		let c = values[0] ?? {}
		return {
			maxOptions: c.maxOptions ?? 200,
			nearbyLines: c.nearbyLines ?? 200,
			minLength: c.minLength ?? 2,
			syncIndexLimit: c.syncIndexLimit ?? 100_000,
		}
	},
})

/// Recount from scratch when changes cover more than this share of the
/// document (a replaced document, a big paste).
const REBUILD_SHARE = 0.3
/// Lines scanned between clock checks while indexing.
const LINE_BATCH = 128
/// Characters scanned around the cursor at most (long lines).
const NEARBY_CHARS = 30_000
const SLICE_MS = 6

function wordRegExp(wordChars: string) {
	let extra = wordChars.replace(/[\]\\^-]/g, "\\$&")
	return new RegExp(`[\\p{Alphabetic}\\p{Number}_${extra}]+`, "ug")
}

function skipWord(word: string, minLength: number) {
	if (word.length < minLength) return true
	let c = word.charCodeAt(0)
	return c >= 48 && c <= 57
}

/// The words of one wordChars set in one document.
export class WordSet {
	/// Occurrences per word, for `base` with every line before `scanned`
	/// counted (all of them once `built`).
	readonly counts = new Map<string, number>()
	/// Distinct words sorted by their lowercase form (`lower` holds it),
	/// once built. Words whose count dropped to zero stay until compacted.
	private sorted: string[] | null = null
	private lower: string[] = []
	private added: string[] = []
	private dead = 0
	private scanned = 1
	built = false
	pending: ChangeSet | null = null
	readonly re: RegExp

	constructor(readonly wordChars: string, public base: Text, private minLength: number) {
		this.re = wordRegExp(wordChars)
	}

	/// Count the words of `text` with `sign` (1 or -1).
	private count(text: string, sign: number) {
		let re = this.re, counts = this.counts, m
		re.lastIndex = 0
		while ((m = re.exec(text))) {
			let w = m[0]
			if (skipWord(w, this.minLength)) continue
			let n = (counts.get(w) ?? 0) + sign
			if (n > 0) {
				if (n == 1 && sign > 0 && this.sorted) this.added.push(w)
				counts.set(w, n)
			} else {
				counts.delete(w)
				if (this.sorted) this.dead++
			}
		}
	}

	noteChanges(changes: ChangeSet) {
		this.pending = this.pending ? this.pending.compose(changes) : changes
	}

	/// Scan lines of `base` until `deadline` (a `performance.now()` time).
	/// Returns true when the whole document is counted.
	build(deadline: number) {
		let doc = this.base
		while (this.scanned <= doc.lines) {
			let end = Math.min(doc.lines + 1, this.scanned + LINE_BATCH)
			for (let iter = doc.iterLines(this.scanned, end); !iter.next().done;) this.count(iter.value, 1)
			this.scanned = end
			if (performance.now() > deadline) break
		}
		if (this.scanned <= doc.lines) return false
		this.built = true
		this.sort()
		return true
	}

	/// Bring the counts from `base` to `doc` by recounting the lines the
	/// pending changes touched. Returns false when the changes were too
	/// big and the set has to be built again.
	sync(doc: Text) {
		let changes = this.pending
		if (!this.built || !changes) return true
		this.pending = null
		let old = this.base
		this.base = doc
		let spans: [number, number, number, number][] = [], size = 0
		changes.iterChangedRanges((fromA, toA, fromB, toB) => {
			let oFrom = old.lineAt(fromA).from, oTo = old.lineAt(toA).to
			let nFrom = doc.lineAt(fromB).from, nTo = doc.lineAt(toB).to
			let last = spans[spans.length - 1]
			// Changes on the same line expand to overlapping spans: merge
			// them so their lines are counted once.
			if (last && (oFrom <= last[1] || nFrom <= last[3])) {
				size += Math.max(0, oTo - last[1]) + Math.max(0, nTo - last[3])
				last[1] = Math.max(last[1], oTo)
				last[3] = Math.max(last[3], nTo)
			} else {
				spans.push([oFrom, oTo, nFrom, nTo])
				size += oTo - oFrom + nTo - nFrom
			}
		})
		if (size > (old.length + doc.length) * REBUILD_SHARE) {
			this.reset(doc)
			return false
		}
		for (let [oFrom, oTo, nFrom, nTo] of spans) {
			this.count(old.sliceString(oFrom, oTo), -1)
			this.count(doc.sliceString(nFrom, nTo), 1)
		}
		return true
	}

	reset(doc: Text) {
		this.counts.clear()
		this.sorted = null
		this.lower = []
		this.added = []
		this.dead = 0
		this.scanned = 1
		this.built = false
		this.pending = null
		this.base = doc
	}

	private sort() {
		let words = [...this.counts.keys()]
		let keyed = words.map(w => ({w, l: w.toLowerCase()}))
		keyed.sort((a, b) => a.l < b.l ? -1 : a.l > b.l ? 1 : a.w < b.w ? -1 : a.w > b.w ? 1 : 0)
		this.sorted = keyed.map(k => k.w)
		this.lower = keyed.map(k => k.l)
		this.added = []
		this.dead = 0
	}

	/// Merge words added since the last sort, and drop dead ones when
	/// there are many.
	private tidy() {
		let sorted = this.sorted!
		if (this.dead > 64 && this.dead > sorted.length / 4 || this.added.length > 256) {
			this.sort()
			return
		}
		for (let w of this.added) {
			if (!this.counts.has(w)) continue
			let l = w.toLowerCase(), lo = 0, hi = sorted.length
			while (lo < hi) {
				let mid = (lo + hi) >> 1
				let ml = this.lower[mid]
				if (ml < l || ml == l && sorted[mid] < w) lo = mid + 1
				else hi = mid
			}
			if (sorted[lo] == w) continue
			sorted.splice(lo, 0, w)
			this.lower.splice(lo, 0, l)
		}
		this.added = []
	}

	/// Words starting with `prefix` (ignoring case), in sorted order, for
	/// as long as `f` returns true.
	eachWithPrefix(prefix: string, f: (word: string) => boolean) {
		if (!this.sorted) return
		this.tidy()
		let sorted = this.sorted, lower = this.lower, p = prefix.toLowerCase()
		let lo = 0, hi = sorted.length
		while (lo < hi) {
			let mid = (lo + hi) >> 1
			if (lower[mid] < p) lo = mid + 1
			else hi = mid
		}
		for (let i = lo; i < sorted.length && lower[i].startsWith(p); i++) {
			if (this.counts.has(sorted[i]) && !f(sorted[i])) return
		}
	}
}

/// Documents whose view was destroyed (a tab switch with `setState`),
/// keyed by the last document seen, so showing them again doesn't index
/// them from scratch.
const savedSets = new WeakMap<Text, Map<string, WordSet>>()

const requestIdle: (f: (deadline?: {timeRemaining(): number}) => void) => number =
	typeof requestIdleCallback == "function" ? f => requestIdleCallback(f, {timeout: 300}) : f => setTimeout(f, 16) as unknown as number
const cancelIdle: (id: number) => void =
	typeof cancelIdleCallback == "function" ? id => cancelIdleCallback(id) : id => clearTimeout(id)

class WordIndexPlugin {
	sets: Map<string, WordSet>
	/// The document as of the last update this plugin got. Sets sync to
	/// it, never to a query's document: autocompletion queries from its
	/// own plugin's update, which may run before this one's, and the
	/// changes of that update aren't pending here yet.
	private doc: Text
	private scheduled = -1

	constructor(readonly view: EditorView) {
		this.doc = view.state.doc
		let saved = savedSets.get(this.doc)
		this.sets = saved ?? new Map()
		if (saved) {
			savedSets.delete(this.doc)
			if ([...saved.values()].some(s => !s.built)) this.schedule()
		}
	}

	update(update: ViewUpdate) {
		this.doc = update.state.doc
		if (!update.docChanged) return
		// A set still building counts its `base`; changes pile up
		// relative to it and are applied once it's done.
		for (let set of this.sets.values()) set.noteChanges(update.changes)
	}

	/// The set for `wordChars`, brought up to date as far as it's built.
	set(wordChars: string) {
		let config = this.view.state.facet(wordConfig)
		let set = this.sets.get(wordChars)
		if (!set) {
			set = new WordSet(wordChars, this.doc, config.minLength)
			this.sets.set(wordChars, set)
		}
		// A sync whose changes were too big resets the set, which is then
		// built again like a new one.
		if (set.built) set.sync(this.doc)
		if (!set.built) {
			if (set.base.length <= config.syncIndexLimit) {
				set.build(Infinity)
				if (!set.sync(this.doc)) set.build(Infinity)
			} else {
				this.schedule()
			}
		}
		return set
	}

	private schedule() {
		if (this.scheduled >= 0) return
		this.scheduled = requestIdle(deadline => {
			this.scheduled = -1
			let end = performance.now() + Math.max(2, Math.min(SLICE_MS, deadline ? deadline.timeRemaining() : SLICE_MS))
			for (let set of this.sets.values()) {
				if (set.built) continue
				if (!set.build(end)) break
				set.sync(this.doc)
			}
			if ([...this.sets.values()].some(s => !s.built)) this.schedule()
		})
	}

	destroy() {
		if (this.scheduled >= 0) cancelIdle(this.scheduled)
		this.scheduled = -1
		if (this.sets.size) savedSets.set(this.doc, this.sets)
	}
}

const wordIndexPlugin = ViewPlugin.fromClass(WordIndexPlugin)

/// Keeps the index [`completeWords`](#completeWords) answers from. It
/// does nothing until the first completion query, so it can be added to
/// every view. Works with CanvasView and CodeMirror's EditorView alike.
export function wordIndex(config: WordCompletionConfig = {}): Extension {
	return [wordConfig.of(config), wordIndexPlugin]
}

/// A completion source offering the document's words, from the index
/// [`wordIndex`](#wordIndex) keeps (null when it isn't in the view).
/// Words on the lines around the cursor come first.
export function completeWords(context: CompletionContext): CompletionResult | null {
	let view = context.view
	let plugin = view?.plugin(wordIndexPlugin)
	if (!plugin) return null
	let {state, pos} = context
	let config = state.facet(wordConfig)
	let wordChars = (state.languageDataAt<string>("wordChars", pos)[0]) ?? ""
	let set = plugin.set(wordChars)
	let token = context.matchBefore(new RegExp(set.re.source + "$", "u"))
	if (!token && !context.explicit) return null
	let from = token ? token.from : pos
	let prefix = token ? token.text : ""
	let lowerPrefix = prefix.toLowerCase()
	// The whole word at the cursor (it may continue after it): not offered
	// for itself.
	let after = new RegExp("^" + set.re.source, "u").exec(state.doc.sliceString(pos, Math.min(state.doc.length, pos + 200)))
	let current = prefix + (after ? after[0] : "")

	let options: Completion[] = [], seen = new Set<string>(), truncated = false
	let matches = (word: string) => {
		if (!lowerPrefix) return true
		let lw = word.toLowerCase()
		if (lw[0] != lowerPrefix[0]) return false
		for (let i = 1, j = 1; i < lowerPrefix.length; i++, j++) {
			j = lw.indexOf(lowerPrefix[i], j)
			if (j < 0) return false
		}
		return true
	}
	let add = (word: string, boost: number) => {
		if (seen.has(word)) return true
		seen.add(word)
		if (options.length >= config.maxOptions) { truncated = true; return false }
		options.push(boost ? {label: word, type: "text", boost} : {label: word, type: "text"})
		return true
	}

	// Lines around the cursor, nearest first.
	let doc = state.doc, line = doc.lineAt(pos), re = new RegExp(set.re.source, "gu")
	let half = config.nearbyLines >> 1, chars = 0
	for (let d = 0; d <= half && chars < NEARBY_CHARS && !truncated; d++) {
		for (let n of d ? [line.number - d, line.number + d] : [line.number]) {
			if (n < 1 || n > doc.lines) continue
			let l = doc.line(n), text = l.text, start = 0
			if (text.length > NEARBY_CHARS) {
				// A long line: just the part around the cursor (or its start).
				start = n == line.number ? Math.max(0, pos - l.from - NEARBY_CHARS / 2) : 0
				text = text.slice(start, start + NEARBY_CHARS)
			}
			chars += text.length
			re.lastIndex = 0
			let m
			while ((m = re.exec(text))) {
				let w = m[0], at = l.from + start + m.index
				if (skipWord(w, config.minLength) || !matches(w)) continue
				if (at <= pos && at + w.length >= pos && n == line.number) continue
				if (!add(w, d <= half / 4 ? 2 : 1)) break
			}
		}
	}

	// The rest of the document, by prefix.
	if (lowerPrefix && set.built && !truncated) {
		set.eachWithPrefix(prefix, w => {
			if (skipWord(w, config.minLength)) return true
			if (w == current && (set.counts.get(w) ?? 0) <= 1) return true
			return add(w, 0)
		})
	}

	let whole = new RegExp("^" + set.re.source + "$", "u")
	return {
		from,
		options,
		// Narrowing the same word filters this result, unless it was cut
		// short or the index wasn't ready (then ask again).
		validFor: truncated || !set.built ? undefined : (text: string) => text.toLowerCase().startsWith(lowerPrefix) && whole.test(text),
	}
}

/// [`wordIndex`](#wordIndex) plus [`completeWords`](#completeWords) as
/// a language-data completion source, for setups that don't override
/// the sources.
export function wordCompletion(config: WordCompletionConfig = {}): Extension {
	return [wordIndex(config), EditorState.languageData.of(() => [{autocomplete: completeWords}])]
}
