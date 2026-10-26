import {CharCategory, EditorSelection, EditorState, findClusterBreak, type Transaction} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {clipboardFilter} from "./input"
import type {MagnifierConfig} from "./magnifier"

export type HandleKind = "cursor" | "start" | "end"

/// What a consumer needs to draw its own selection menu.
export type SelectionMenuEvent = {
	type: "show"
	/// "cursor" when shown for a caret (tap on the cursor handle),
	/// "selection" for a non-empty selection.
	trigger: "cursor" | "selection"
	/// Client rect around the selection (or the caret line).
	selectionRect: DOMRect
	/// Client rect of the handle that triggered the menu, if any.
	handleRect: DOMRect | null
	readOnly: boolean
} | {
	type: "hide"
	/// True when hidden only for the duration of a scroll or drag; a
	/// "show" follows when it settles.
	transient: boolean
}

export interface TouchSelectionConfig {
	/// Selection handle size in CSS px (the teardrop's square side);
	/// 0 disables handles. Default 20.
	handleSize?: number
	/// How long the cursor handle stays after a tap, in ms. Default 3000.
	cursorHandleTimeout?: number
	/// Show/hide requests for the consumer's selection menu (copy, cut,
	/// paste...). The library draws no menu itself.
	onMenu?: (event: SelectionMenuEvent) => void
	/// Called when a word or line gets selected by touch, or a text drag
	/// starts (for a vibration).
	onHaptic?: (kind: "word" | "line" | "drag") => void
	/// Override the range a long-press or double-tap selects (e.g. a CSS
	/// color literal). Return null for the default word range.
	wordRange?: (state: EditorState, pos: number) => {from: number, to: number} | null
	/// Show a magnifier over the text while a finger drags a handle,
	/// extends a long-press selection or moves selected text, like
	/// Android's text fields (the finger hides that text). It hides
	/// while the finger is in the top or bottom auto-scroll zone.
	/// Default true.
	magnifier?: boolean | MagnifierConfig
}

/// What touch selection needs from the view.
export interface TouchSelectionHost {
	readonly state: EditorState
	readonly surface: HTMLElement
	readonly lineHeight: number
	readonly width: number
	readonly height: number
	scrollTop: number
	scrollLeft: number
	dispatch(...specs: any[]): void
	posAtClient(x: number, y: number): number
	/// Position and cursor side (`assoc`) at client coordinates.
	posAndSideAtClient(x: number, y: number): {pos: number, side: number}
	/// Client coordinates of the bottom of the line at `pos`, at its x
	/// (`side` < 0: at the end of a wrapped row).
	handleAnchor(pos: number, side?: number): {x: number, y: number}
	/// Show (or hide, with null) the drop cursor of a text drag.
	setDropPos(pos: number | null): void
	requestFrame(): void
	focus(): void
}

const TAP_INTERVAL = 400
/// Handle hit areas extend this much (relative to the size) beyond the
/// drawn shape, so they are easy to grab.
const HIT_SLOP = 0.6
const AUTOSCROLL_ZONE = 1.2

/// Touch selection mechanics in the style of Acode's Ace touch handler
/// and native Android editors: tap places the caret (with a teardrop
/// handle), double tap selects a word, triple tap a line, long press
/// selects a word and dragging extends it, and selection handles can be
/// dragged (with auto-scroll at the edges). The menu is left to the
/// consumer through `onMenu`.
export class TouchSelection {
	/// Which handles are shown.
	mode: "none" | "cursor" | "selection" = "none"
	/// Bumped when what's drawn changes (handles), for redraw keys.
	version = 0
	readonly handleSize: number
	private menuWanted = false
	private menuShown = false
	private menuTrigger: "cursor" | "selection" = "selection"
	private cursorTimer: ReturnType<typeof setTimeout> | null = null
	private lastTap = {time: 0, pos: -1, count: 0}
	private drag: {kind: HandleKind | "extend" | "text", dx: number, dy: number, x: number, y: number, moved: boolean,
		/// The selection end that stays put (for "extend": the pressed
		/// word; for "text": the dragged range).
		fixed: number, fixedTo: number} | null = null
	private autoscrollFrame = 0
	/// Set while dispatching our own selection changes.
	private own = false
	/// The center of what the magnifier shows during a drag, in CSS px
	/// in the surface.
	magnifierPoint: {x: number, y: number} | null = null

	constructor(private host: TouchSelectionHost, private config: TouchSelectionConfig = {}) {
		this.handleSize = config.handleSize ?? 20
	}

	get dragging() { return !!this.drag }

	private setMode(mode: TouchSelection["mode"]) {
		if (mode != this.mode) {
			this.mode = mode
			this.version++
			this.host.requestFrame()
		}
		if (this.cursorTimer != null) clearTimeout(this.cursorTimer)
		this.cursorTimer = null
		if (mode == "cursor") {
			this.cursorTimer = setTimeout(() => {
				this.cursorTimer = null
				if (this.mode == "cursor" && !this.drag) {
					this.setMode("none")
					if (this.menuTrigger == "cursor") this.hideMenu()
				}
			}, this.config.cursorHandleTimeout ?? 3000)
		}
	}

	/// `assoc` -1 places a caret at the end of a wrapped row.
	private select(anchor: number, head: number, assoc = 0) {
		this.own = true
		try {
			let selection = anchor == head ? EditorSelection.create([EditorSelection.cursor(head, assoc)]) : EditorSelection.single(anchor, head)
			this.host.dispatch({selection, userEvent: "select.pointer", scrollIntoView: false})
		} finally {
			this.own = false
		}
	}

	// ---- Menu -------------------------------------------------------------------

	private showMenu(trigger: "cursor" | "selection", handle: HandleKind | null) {
		this.menuWanted = true
		this.menuTrigger = trigger
		this.emitShow(handle)
	}

	private emitShow(handle: HandleKind | null) {
		if (!this.config.onMenu) return
		this.menuShown = true
		this.config.onMenu({
			type: "show", trigger: this.menuTrigger,
			selectionRect: this.selectionRect(),
			handleRect: handle ? this.handleRect(handle) : this.mode == "selection" ? this.handleRect("end") : null,
			readOnly: this.host.state.readOnly
		})
	}

	hideMenu(transient = false) {
		if (!transient) this.menuWanted = false
		if (this.menuShown) {
			this.menuShown = false
			this.config.onMenu?.({type: "hide", transient})
		}
	}

	/// Show the consumer's menu for the current selection (e.g. from a
	/// toolbar button).
	openMenu() {
		let sel = this.host.state.selection.main
		if (!sel.empty) this.setMode("selection")
		this.showMenu(sel.empty ? "cursor" : "selection", null)
	}

	private selectionRect() {
		let sel = this.host.state.selection.main, lh = this.host.lineHeight
		let a = this.host.handleAnchor(sel.from), b = this.host.handleAnchor(sel.to)
		let rect = this.host.surface.getBoundingClientRect()
		let left = a.y == b.y ? Math.min(a.x, b.x) : rect.left, right = a.y == b.y ? Math.max(a.x, b.x) : rect.right
		return new DOMRect(left, a.y - lh, Math.max(1, right - left), b.y - (a.y - lh))
	}

	// ---- Handles ----------------------------------------------------------------

	/// Handles to draw: kind, document position and side (the end of a
	/// wrapped row or the start of the next, as the cursor or selection
	/// edge is drawn).
	handles(): {kind: HandleKind, pos: number, side: number}[] {
		if (!this.handleSize) return []
		let sel = this.host.state.selection.main
		if (this.mode == "cursor" && sel.empty) return [{kind: "cursor", pos: sel.head, side: sel.assoc}]
		if (this.mode == "selection" && !sel.empty) return [{kind: "start", pos: sel.from, side: 1}, {kind: "end", pos: sel.to, side: -1}]
		return []
	}

	/// Client rect of a handle's drawn shape.
	handleRect(kind: HandleKind) {
		let sel = this.host.state.selection.main, s = this.handleSize
		let pos = kind == "start" ? sel.from : kind == "end" ? sel.to : sel.head
		let {x, y} = this.host.handleAnchor(pos, kind == "start" ? 1 : kind == "end" ? -1 : sel.assoc)
		if (kind == "cursor") {
			let d = s * Math.SQRT2
			return new DOMRect(x - d / 2, y, d, d)
		}
		return new DOMRect(kind == "start" ? x - s : x, y, s, s)
	}

	private hitHandle(x: number, y: number): HandleKind | null {
		for (let {kind} of this.handles()) {
			let r = this.handleRect(kind), pad = this.handleSize * HIT_SLOP
			if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad / 2 && y <= r.bottom + pad) return kind
		}
		return null
	}

	// ---- Gestures (called by the view) --------------------------------------------

	onTap(x: number, y: number, e: PointerEvent) {
		let state = this.host.state
		let {pos, side} = this.host.posAndSideAtClient(x, y)
		let now = e.timeStamp
		let t = this.lastTap
		let sameSpot = t.pos >= 0 && Math.abs(state.doc.lineAt(t.pos).number - state.doc.lineAt(pos).number) == 0 && Math.abs(t.pos - pos) <= 2
		t.count = now - t.time < TAP_INTERVAL && sameSpot ? t.count + 1 : 1
		t.time = now
		t.pos = pos
		this.host.focus()
		// `EditorView.clickAddsSelectionRange` (a hardware Ctrl, or a
		// consumer's own modifier, like a toolbar Ctrl key) adds a
		// cursor, or removes the range tapped.
		if (t.count == 1 && addsSelectionRange(state, e)) {
			let sel = state.selection
			let next = (sel.ranges.length > 1 && removeRangeAround(sel, pos)) || sel.addRange(EditorSelection.cursor(pos, side))
			this.hideMenu()
			this.own = true
			try {
				this.host.dispatch({selection: next, userEvent: "select.pointer", scrollIntoView: false})
			} finally {
				this.own = false
			}
			this.setMode("none")
			return
		}
		if (e.shiftKey) {
			this.select(state.selection.main.anchor, pos)
			this.setMode("selection")
			this.showMenu("selection", "end")
			return
		}
		if (t.count == 2) {
			if (this.selectWord(pos, this.biasAt(pos, x))) this.config.onHaptic?.("word")
			return
		}
		if (t.count >= 3) {
			let line = state.doc.lineAt(pos)
			this.select(line.from, Math.min(state.doc.length, line.to + 1))
			this.setMode("selection")
			this.showMenu("selection", "end")
			this.config.onHaptic?.("line")
			return
		}
		this.hideMenu()
		this.select(pos, pos, side)
		this.setMode(this.handleSize ? "cursor" : "none")
	}

	/// Whether the client x is on the character before (-1) or after (1)
	/// the position nearest to it.
	private biasAt(pos: number, x: number) {
		return this.host.handleAnchor(pos).x > x ? -1 : 1
	}

	private selectWord(pos: number, bias: number) {
		let state = this.host.state
		let range = this.config.wordRange?.(state, pos) ?? wordRangeAt(state, pos, bias)
		if (!range) {
			this.select(pos, pos)
			this.setMode("cursor")
			return false
		}
		this.select(range.from, range.to)
		this.setMode("selection")
		this.showMenu("selection", "end")
		return true
	}

	claimTouch(x: number, y: number): boolean {
		let kind = this.hitHandle(x, y)
		if (!kind) return false
		let sel = this.host.state.selection.main
		let pos = kind == "start" ? sel.from : kind == "end" ? sel.to : sel.head
		let a = this.host.handleAnchor(pos, kind == "start" ? 1 : kind == "end" ? -1 : sel.assoc)
		// Keep the finger's offset to the text point the handle marks.
		let fixed = kind == "start" ? sel.to : sel.from
		this.drag = {kind, dx: a.x - x, dy: a.y - this.host.lineHeight / 2 - y, x, y, moved: false, fixed, fixedTo: fixed}
		if (this.cursorTimer != null) clearTimeout(this.cursorTimer)
		this.cursorTimer = null
		return true
	}

	onLongPress(x: number, y: number): boolean {
		let pos = this.host.posAtClient(x, y)
		this.host.focus()
		let state = this.host.state
		// A long press on the selected text picks it up: dragging moves
		// it (like Android's text fields), releasing in place keeps it.
		let main = state.selection.main
		if (!state.readOnly && !main.empty && this.onSelection(pos, x)) {
			this.hideMenu()
			this.setMode("none")
			this.config.onHaptic?.("drag")
			this.drag = {kind: "text", dx: 0, dy: 0, x, y, moved: false, fixed: main.from, fixedTo: main.to}
			this.host.setDropPos(pos)
			this.lastTap.count = 0
			return true
		}
		let range = this.config.wordRange?.(state, pos) ?? wordRangeAt(state, pos, this.biasAt(pos, x)) ?? {from: pos, to: pos}
		this.select(range.from, range.to)
		this.setMode(range.from == range.to ? "cursor" : "selection")
		this.config.onHaptic?.("word")
		// Dragging after a long press extends the selection by moving its
		// end under the finger.
		this.drag = {kind: "extend", dx: 0, dy: 0, x, y, moved: false, fixed: range.from, fixedTo: range.to}
		this.lastTap.count = 0
		return true
	}

	gestureMove(x: number, y: number) {
		let d = this.drag
		if (!d) return
		if (!d.moved && Math.hypot(x - d.x, y - d.y) < 4) return
		if (!d.moved) {
			d.moved = true
			this.hideMenu(true)
		}
		d.x = x
		d.y = y
		this.applyDrag()
		this.autoscroll()
	}

	/// Whether a point is on the main selection's text (at a boundary,
	/// on the selected side of it).
	private onSelection(pos: number, x: number) {
		let {from, to} = this.host.state.selection.main
		if (pos < from || pos > to) return false
		if (pos > from && pos < to) return true
		let side = this.biasAt(pos, x)
		return pos == from ? side > 0 : side < 0
	}

	private applyDrag() {
		let d = this.drag!
		let {pos, side} = this.host.posAndSideAtClient(d.x + d.dx, d.y + d.dy)
		if (d.kind == "text") {
			this.host.setDropPos(pos)
			this.magnify()
			return
		}
		if (d.kind == "cursor") {
			this.select(pos, pos, side)
			this.magnify()
			return
		}
		let doc = this.host.state.doc, fixed = d.fixed
		if (d.kind == "extend") {
			// The long-pressed word stays selected; the selection grows
			// toward the finger in either direction.
			if (pos < d.fixed) this.select(d.fixedTo, pos)
			else this.select(d.fixed, Math.max(pos, d.fixedTo))
			if (this.host.state.selection.main.empty) this.setMode("cursor")
			else this.setMode("selection")
			this.magnify()
			return
		}
		// Selections from a handle drag never collapse to a caret.
		if (pos == fixed) {
			let line = doc.lineAt(pos)
			let forward = d.kind == "end"
			pos = forward ? (pos < line.to ? line.from + findClusterBreak(line.text, pos - line.from, true) : Math.min(doc.length, pos + 1))
				: (pos > line.from ? line.from + findClusterBreak(line.text, pos - line.from, false) : Math.max(0, pos - 1))
		}
		this.select(fixed, pos)
		this.magnify()
	}

	/// The magnifier follows the finger both ways, like sora-editor's:
	/// on a handle, centered on the top of the row it drags; on the text
	/// (a long-press drag), a row above the finger.
	private magnify() {
		if (this.config.magnifier === false || !this.drag?.moved) return
		let d = this.drag, rect = this.host.surface.getBoundingClientRect(), lh = this.host.lineHeight
		// Scrolling rows under it would only flicker; a horizontal
		// auto-scroll keeps the row, and the magnifier stays readable.
		if (this.edgeDelta(d.x, d.y, rect).dy) {
			this.endMagnifier()
			return
		}
		let y = d.kind == "extend" || d.kind == "text" ? d.y - lh : d.y + d.dy - lh / 2
		this.magnifierPoint = {x: d.x + d.dx - rect.left, y: y - rect.top}
		this.host.requestFrame()
	}

	private endMagnifier() {
		if (!this.magnifierPoint) return
		this.magnifierPoint = null
		this.host.requestFrame()
	}

	/// How far a point is into the edges' auto-scroll zones (0 outside).
	private edgeDelta(x: number, y: number, rect: DOMRect) {
		let zone = this.host.lineHeight * AUTOSCROLL_ZONE
		let dy = y < rect.top + zone ? -(rect.top + zone - y) : y > rect.bottom - zone ? y - (rect.bottom - zone) : 0
		let dx = x < rect.left + zone ? -(rect.left + zone - x) : x > rect.right - zone ? x - (rect.right - zone) : 0
		return {dx, dy}
	}

	/// Scroll while a handle is dragged near the edges.
	private autoscroll() {
		cancelAnimationFrame(this.autoscrollFrame)
		let d = this.drag
		if (!d) return
		let {dx, dy} = this.edgeDelta(d.x, d.y, this.host.surface.getBoundingClientRect())
		if (!dx && !dy) return
		let step = () => {
			if (!this.drag) return
			let top = this.host.scrollTop, left = this.host.scrollLeft
			this.host.scrollTop = top + Math.sign(dy) * Math.min(40, Math.abs(dy) * 0.35)
			this.host.scrollLeft = left + Math.sign(dx) * Math.min(40, Math.abs(dx) * 0.35)
			if (this.host.scrollTop == top && this.host.scrollLeft == left) return
			this.applyDrag()
			this.autoscrollFrame = requestAnimationFrame(step)
		}
		this.autoscrollFrame = requestAnimationFrame(step)
	}

	gestureEnd(_x: number, _y: number, cancelled = false) {
		let d = this.drag
		this.drag = null
		this.endMagnifier()
		cancelAnimationFrame(this.autoscrollFrame)
		if (!d) return
		if (d.kind == "text") {
			this.host.setDropPos(null)
			if (d.moved && !cancelled) this.dropText(d.fixed, d.fixedTo, this.host.posAtClient(d.x, d.y))
			this.setMode("selection")
			this.showMenu("selection", "end")
			return
		}
		let sel = this.host.state.selection.main
		if (d.kind == "cursor") {
			this.setMode("cursor")
			// Tapping the cursor handle toggles the menu.
			if (!d.moved) {
				if (this.menuShown) this.hideMenu()
				else this.showMenu("cursor", "cursor")
			}
			return
		}
		if (sel.empty) {
			this.setMode("cursor")
			return
		}
		this.setMode("selection")
		this.showMenu("selection", d.kind == "start" ? "start" : "end")
	}

	/// Move the dragged text to `pos`; the moved text stays selected.
	private dropText(from: number, to: number, pos: number) {
		let state = this.host.state
		this.own = true
		try {
			if (pos >= from && pos <= to) {
				this.host.dispatch({selection: EditorSelection.range(from, to), userEvent: "select.pointer", scrollIntoView: false})
				return
			}
			// Like a mouse drag within CodeMirror, whose text goes through
			// the output filter (drag start) and the input one (drop).
			let text = clipboardFilter(state, "input", clipboardFilter(state, "output", state.sliceDoc(from, to))).replace(/\r\n?/g, "\n")
			if (!text) return
			let changes = state.changes([{from, to}, {from: pos, insert: text}])
			this.host.dispatch({
				changes,
				selection: EditorSelection.range(changes.mapPos(pos, -1), changes.mapPos(pos, 1)),
				userEvent: "move.drop", scrollIntoView: false
			})
		} finally {
			this.own = false
		}
	}

	onScrollStart() {
		if (this.menuShown) this.hideMenu(true)
	}

	onScrollEnd() {
		if (this.menuWanted && !this.menuShown && !this.drag) this.emitShow(null)
	}

	/// Selection or document changes from elsewhere (keyboard, commands)
	/// drop the handles and the menu.
	onUpdate(trs: readonly Transaction[]) {
		// The last tap's position is read on the next tap (double-tap
		// detection), so it must stay valid in the new document.
		let t = this.lastTap
		if (t.pos >= 0) for (let tr of trs) if (tr.docChanged) t.pos = tr.changes.mapPos(t.pos)
		if (this.own) return
		let docChanged = trs.some(tr => tr.docChanged)
		let selChanged = trs.some(tr => tr.selection)
		if (!docChanged && !selChanged) return
		if (this.mode != "none") this.setMode("none")
		this.hideMenu()
	}

	/// The view switched to an unrelated state: drop handles, menu,
	/// any drag and the last tap (their positions are in the old document).
	reset() {
		if (this.drag?.kind == "text") this.host.setDropPos(null)
		this.drag = null
		this.endMagnifier()
		this.lastTap = {time: 0, pos: -1, count: 0}
		if (this.mode != "none") this.setMode("none")
		this.hideMenu()
	}

	destroy() {
		if (this.drag?.kind == "text") this.host.setDropPos(null)
		if (this.cursorTimer != null) clearTimeout(this.cursorTimer)
		cancelAnimationFrame(this.autoscrollFrame)
	}
}

export const mac = typeof navigator != "undefined" && /Mac/.test(navigator.platform)

/// `EditorView.clickAddsSelectionRange`, with CodeMirror's default
/// (Cmd on macOS, Ctrl elsewhere). Taps use it too, so a consumer can
/// map a toolbar modifier (Acode's quick tools Ctrl) to adding cursors.
export function addsSelectionRange(state: EditorState, event: MouseEvent) {
	if (!state.facet(EditorState.allowMultipleSelections)) return false
	let facet = state.facet(EditorView.clickAddsSelectionRange)
	return facet.length ? facet[0](event) : mac ? event.metaKey : event.ctrlKey
}

/// Remove the range around `pos` from a multi-range selection
/// (Ctrl-clicking a cursor removes it).
export function removeRangeAround(sel: EditorSelection, pos: number) {
	for (let i = 0; i < sel.ranges.length; i++) {
		let {from, to} = sel.ranges[i]
		if (from <= pos && to >= pos)
			return EditorSelection.create(sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1)),
				sel.mainIndex == i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0))
	}
	return null
}

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u
// Emoji get a group of their own: CodeMirror counts them as "Other",
// which would select `(😀)` together with the brackets around it.
const EMOJI_GROUP = -1

/// The group of characters at a position, for double taps, long presses
/// and double clicks: a word (by the state's character categorizer), a
/// run of symbols (`===`, `=>`) or a run of emoji. `bias` says which
/// character the point was on: the one before `pos` (-1) or after it
/// (1). Null on whitespace and empty lines.
export function wordRangeAt(state: EditorState, pos: number, bias = 1): {from: number, to: number} | null {
	let line = state.doc.lineAt(pos), text = line.text, at = pos - line.from
	if (!text.length) return null
	let categorize = state.charCategorizer(pos)
	let group = (from: number, to: number): number => {
		let s = text.slice(from, to)
		return EMOJI.test(s) ? EMOJI_GROUP : categorize(s)
	}
	let before = at > 0 ? findClusterBreak(text, at, false) : at
	let after = at < text.length ? findClusterBreak(text, at, true) : at
	// The character under the point first, then its neighbour (a tap
	// just past a word's end still selects the word).
	let sides: [number, number][] = bias < 0 ? [[before, at], [at, after]] : [[at, after], [before, at]]
	for (let [from, to] of sides) {
		if (from == to) continue
		let cat = group(from, to)
		if (cat == CharCategory.Space) continue
		while (from > 0) {
			let prev = findClusterBreak(text, from, false)
			if (group(prev, from) != cat) break
			from = prev
		}
		while (to < text.length) {
			let next = findClusterBreak(text, to, true)
			if (group(to, next) != cat) break
			to = next
		}
		return {from: line.from + from, to: line.from + to}
	}
	return null
}
