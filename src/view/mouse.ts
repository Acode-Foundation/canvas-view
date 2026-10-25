import {EditorSelection, EditorState, type SelectionRange} from "@codemirror/state"
import {EditorView, type ViewUpdate} from "@codemirror/view"
import {clipboardFilter} from "./input"
import {addsSelectionRange, mac, removeRangeAround, wordRangeAt} from "./touchselect"

/// CodeMirror's `MouseSelectionStyle` (what `EditorView.mouseSelectionStyle`
/// providers, e.g. `rectangularSelection`, return).
export interface MouseSelectionStyle {
	get(curEvent: MouseEvent, extend: boolean, multiple: boolean): EditorSelection
	update(update: ViewUpdate): boolean | void
}

/// What mouse selection and drag-and-drop need from the view.
export interface MouseHost {
	readonly state: EditorState
	readonly surface: HTMLElement
	readonly lineHeight: number
	readonly font: {family: string, size: number}
	readonly dark: boolean
	scrollTop: number
	scrollLeft: number
	dispatch(...specs: any[]): void
	posAtClient(x: number, y: number): number
	posAndSideAtClient(x: number, y: number): {pos: number, side: number}
	/// Client coordinates of the bottom of `pos`'s row at its x.
	handleAnchor(pos: number, side?: number): {x: number, y: number}
	focus(): void
	/// Keep the editor's focus state while a native drag briefly moves
	/// focus off the input element.
	holdFocus(hold: boolean): void
	runEventHandlers(type: string, event: Event): boolean
	setDropPos(pos: number | null): void
}

/// `EditorView.dragMovesSelection`, with CodeMirror's default (Alt on
/// macOS, Ctrl elsewhere copy instead of moving).
function dragMovesSelection(state: EditorState, event: MouseEvent) {
	let facet = state.facet(EditorView.dragMovesSelection)
	return facet.length ? facet[0](event) : mac ? !event.altKey : !event.ctrlKey
}

/// Which character a client x is on relative to the position nearest
/// to it: the one before (-1) or after (1).
function biasAt(host: MouseHost, pos: number, x: number) {
	return host.handleAnchor(pos).x > x ? -1 : 1
}

function rangeForClick(host: MouseHost, pos: number, bias: number, type: number, side = 0): SelectionRange {
	let state = host.state
	if (type == 1) return EditorSelection.cursor(pos, side)
	if (type == 2) {
		let word = wordRangeAt(state, pos, bias)
		return word ? EditorSelection.range(word.from, word.to) : EditorSelection.cursor(pos)
	}
	let line = state.doc.lineAt(pos)
	return EditorSelection.range(line.from, Math.min(state.doc.length, line.to + 1))
}

/// The default mouse selection: click places the cursor, double click
/// selects a word, triple click a line, and dragging extends by that
/// unit. Shift extends the main range; `multiple` adds a range (or
/// removes the one clicked).
export function basicMouseSelection(host: MouseHost, event: MouseEvent, type: number): MouseSelectionStyle {
	let start = host.posAtClient(event.clientX, event.clientY)
	let startBias = biasAt(host, start, event.clientX)
	let startSel = host.state.selection
	return {
		update(update) {
			if (update.docChanged) {
				start = update.changes.mapPos(start)
				startSel = startSel.map(update.changes)
			}
		},
		get(e, extend, multiple) {
			let {pos: cur, side} = host.posAndSideAtClient(e.clientX, e.clientY), removed
			let range = rangeForClick(host, cur, biasAt(host, cur, e.clientX), type, side)
			if (start != cur && !extend) {
				let startRange = rangeForClick(host, start, startBias, type)
				let from = Math.min(startRange.from, range.from), to = Math.max(startRange.to, range.to)
				range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
			}
			if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to))
			if (multiple && type == 1 && startSel.ranges.length > 1 && (removed = removeRangeAround(startSel, cur))) return removed
			if (multiple) return startSel.addRange(range)
			return EditorSelection.create([range])
		}
	}
}

const DRAG_SCROLL_MARGIN = 6

/// One mouse selection gesture (CodeMirror's `MouseSelection`): runs
/// the style on every move, scrolls when the pointer is at or past
/// the edges, and lets a press inside the selection become a text drag.
export class MouseSelection {
	/// null: pressed inside the selection, may become a native drag;
	/// true: dragging text; false: selecting.
	dragging: boolean | null
	/// Whether the pointer moved enough to select by dragging.
	moved = false
	private lastEvent: MouseEvent
	private extend: boolean
	private multiple: boolean
	private scrollSpeed = {x: 0, y: 0}
	private scrollFrame = 0
	private destroyed = false

	constructor(private host: MouseHost, private startEvent: MouseEvent, private style: MouseSelectionStyle,
		private mustSelect: boolean, clickCount: number, private onDestroy: () => void) {
		this.lastEvent = startEvent
		this.extend = startEvent.shiftKey
		this.multiple = addsSelectionRange(host.state, startEvent)
		this.dragging = clickCount == 1 && inMainSelection(host, startEvent) ? null : false
		window.addEventListener("pointermove", this.move)
		window.addEventListener("pointerup", this.up)
		window.addEventListener("pointercancel", this.cancel)
	}

	start() {
		// Outside the selection, the press selects right away.
		if (this.dragging === false) this.select(this.startEvent)
	}

	private move = (e: PointerEvent) => {
		if (e.pointerType != "mouse") return
		if (e.buttons == 0) return this.destroy()
		if (this.dragging || this.dragging == null && Math.hypot(e.clientX - this.startEvent.clientX, e.clientY - this.startEvent.clientY) < 10) return
		// Moved without a native drag starting: select instead.
		if (this.dragging == null) {
			this.dragging = false
			this.host.surface.draggable = false
		}
		this.moved = true
		this.select(this.lastEvent = e)
		let r = this.host.surface.getBoundingClientRect(), m = DRAG_SCROLL_MARGIN
		let speed = (d: number) => Math.max(2, Math.min(d * 0.7, 25))
		let sx = e.clientX <= r.left + m ? -speed(r.left + m - e.clientX) : e.clientX >= r.right - m ? speed(e.clientX - r.right + m) : 0
		let sy = e.clientY <= r.top + m ? -speed(r.top + m - e.clientY) : e.clientY >= r.bottom - m ? speed(e.clientY - r.bottom + m) : 0
		this.setScrollSpeed(sx, sy)
	}

	private up = (e: PointerEvent) => {
		if (e.pointerType != "mouse") return
		// A click inside the selection that didn't drag places the cursor.
		if (this.dragging == null) this.select(this.lastEvent)
		this.destroy()
	}

	/// A native drag starting takes the pointer away (pointercancel).
	private cancel = (e: PointerEvent) => {
		if (e.pointerType == "mouse") this.destroy()
	}

	private setScrollSpeed(x: number, y: number) {
		this.scrollSpeed = {x, y}
		if ((x || y) && !this.scrollFrame) {
			let step = () => {
				let {x, y} = this.scrollSpeed
				if (this.destroyed || !x && !y) { this.scrollFrame = 0; return }
				let host = this.host, top = host.scrollTop, left = host.scrollLeft
				host.scrollTop = top + y
				host.scrollLeft = left + x
				if (host.scrollTop != top || host.scrollLeft != left) this.select(this.lastEvent)
				this.scrollFrame = requestAnimationFrame(step)
			}
			this.scrollFrame = requestAnimationFrame(step)
		}
	}

	private select(event: MouseEvent) {
		let host = this.host, selection = this.style.get(event, this.extend, this.multiple)
		if (this.mustSelect || !selection.eq(host.state.selection, this.dragging === false))
			host.dispatch({selection, userEvent: "select.pointer"})
		this.mustSelect = false
	}

	update(update: ViewUpdate) {
		if (update.transactions.some(tr => tr.isUserEvent("input.type"))) this.destroy()
		else if (this.style.update(update)) setTimeout(() => { if (!this.destroyed) this.select(this.lastEvent) }, 20)
	}

	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		cancelAnimationFrame(this.scrollFrame)
		window.removeEventListener("pointermove", this.move)
		window.removeEventListener("pointerup", this.up)
		window.removeEventListener("pointercancel", this.cancel)
		this.onDestroy()
	}
}

/// Whether a press is on the main selection's text (a boundary press
/// counts when it's on the selected side of the boundary).
function inMainSelection(host: MouseHost, event: MouseEvent) {
	let {main} = host.state.selection
	if (main.empty) return false
	let pos = host.posAtClient(event.clientX, event.clientY)
	if (pos < main.from || pos > main.to) return false
	if (pos > main.from && pos < main.to) return true
	let side = biasAt(host, pos, event.clientX)
	return pos == main.from ? side > 0 && pos < main.to : side < 0
}

/// Native HTML drag-and-drop of text, like CodeMirror: the selection
/// can be dragged (moved, or copied with the platform modifier) within
/// the editor, to other editors and to other apps, and text or text
/// files can be dropped in. The drop position is drawn by the view.
export class TextDragDrop {
	/// The range being dragged out of this editor.
	dragged: SelectionRange | null = null
	private scrollTime = 0

	constructor(private host: MouseHost) {
		let el = host.surface
		el.addEventListener("dragstart", this.onDragStart)
		el.addEventListener("dragover", this.onDragOver)
		el.addEventListener("dragleave", this.onDragLeave)
		el.addEventListener("drop", this.onDrop)
		el.addEventListener("dragend", this.onDragEnd)
	}

	/// Called for a press inside the selection: let the browser start a
	/// native drag from the surface (the press isn't cancelled), and
	/// return focus to the editor right after the browser moves it.
	prepare() {
		this.host.surface.draggable = true
		this.host.holdFocus(true)
		setTimeout(() => {
			this.host.focus()
			this.host.holdFocus(false)
		}, 0)
	}

	private onDragStart = (e: DragEvent) => {
		let host = this.host
		if (e.target != host.surface) return
		if (host.runEventHandlers("dragstart", e)) return
		let range = host.state.selection.main
		this.dragged = range
		let text = host.state.sliceDoc(range.from, range.to)
		if (e.dataTransfer) {
			e.dataTransfer.setData("text/plain", clipboardFilter(host.state, "output", text))
			e.dataTransfer.effectAllowed = "copyMove"
			this.setDragImage(e.dataTransfer, text, e)
		}
	}

	/// The default drag image would be a picture of the whole editor.
	private setDragImage(dt: DataTransfer, text: string, e: DragEvent) {
		let lines = text.split("\n"), shown = lines.slice(0, 8).map(l => l.length > 60 ? l.slice(0, 60) + "…" : l)
		if (lines.length > 8) shown.push("…")
		let el = document.createElement("pre"), dark = this.host.dark
		el.textContent = shown.join("\n")
		Object.assign(el.style, {
			position: "fixed", left: "-10000px", top: "0", margin: "0", padding: "2px 4px",
			font: `${this.host.font.size}px ${this.host.font.family}`, lineHeight: this.host.lineHeight + "px",
			color: dark ? "#ddd" : "#222", background: dark ? "rgba(40,40,40,0.8)" : "rgba(255,255,255,0.8)", borderRadius: "3px",
			whiteSpace: "pre", pointerEvents: "none"
		} satisfies Partial<CSSStyleDeclaration>)
		document.body.appendChild(el)
		let anchor = this.host.handleAnchor(this.host.state.selection.main.from)
		dt.setDragImage(el, Math.max(0, Math.min(40, e.clientX - anchor.x)), Math.max(0, Math.min(this.host.lineHeight, e.clientY - anchor.y + this.host.lineHeight)))
		setTimeout(() => el.remove(), 0)
	}

	private onDragOver = (e: DragEvent) => {
		let host = this.host, dt = e.dataTransfer
		if (host.runEventHandlers("dragover", e)) return
		if (!dt || host.state.readOnly || !(dt.types.includes("text/plain") || dt.types.includes("Files"))) return
		e.preventDefault()
		dt.dropEffect = this.dragged && dragMovesSelection(host.state, e) ? "move" : "copy"
		host.setDropPos(host.posAtClient(e.clientX, e.clientY))
		this.autoscroll(e)
	}

	/// Scroll while dragging near the edges (dragover repeats while the
	/// pointer rests, so this runs without movement too).
	private autoscroll(e: DragEvent) {
		let host = this.host, r = host.surface.getBoundingClientRect(), zone = host.lineHeight * 1.5
		let now = e.timeStamp, dt = Math.min(100, now - this.scrollTime)
		this.scrollTime = now
		let dy = e.clientY < r.top + zone ? -(r.top + zone - e.clientY) : e.clientY > r.bottom - zone ? e.clientY - (r.bottom - zone) : 0
		let dx = e.clientX < r.left + zone ? -(r.left + zone - e.clientX) : e.clientX > r.right - zone ? e.clientX - (r.right - zone) : 0
		if (dy) host.scrollTop += dy / zone * dt * 0.8
		if (dx) host.scrollLeft += dx / zone * dt * 0.8
		if (dx || dy) host.setDropPos(host.posAtClient(e.clientX, e.clientY))
	}

	private onDragLeave = (e: DragEvent) => {
		if (!this.host.surface.contains(e.relatedTarget as Node | null)) this.host.setDropPos(null)
	}

	private onDrop = (e: DragEvent) => {
		let host = this.host
		host.setDropPos(null)
		if (host.runEventHandlers("drop", e) || !e.dataTransfer) return
		e.preventDefault()
		if (host.state.readOnly) return
		let files = e.dataTransfer.files
		if (files && files.length) {
			// For a file drop, read the files' text (skipping binary ones).
			let text: (string | null)[] = Array(files.length).fill(null), read = 0
			let finish = () => {
				if (++read == files.length) this.dropText(e, text.filter(s => s != null).join(host.state.lineBreak), false)
			}
			for (let i = 0; i < files.length; i++) {
				let reader = new FileReader
				reader.onerror = finish
				reader.onload = () => {
					if (!/[\x00-\x08\x0e-\x1f]{2}/.test(reader.result as string)) text[i] = reader.result as string
					finish()
				}
				reader.readAsText(files[i])
			}
			return
		}
		let text = e.dataTransfer.getData("text/plain")
		if (text) this.dropText(e, text, true)
	}

	private dropText(e: DragEvent, text: string, direct: boolean) {
		let host = this.host, state = host.state
		text = clipboardFilter(state, "input", text).replace(/\r\n?/g, "\n")
		if (!text) return
		let pos = host.posAtClient(e.clientX, e.clientY), dragged = this.dragged
		let del = direct && dragged && dragMovesSelection(state, e) ? {from: dragged.from, to: dragged.to} : null
		this.dragged = null
		host.focus()
		// Dropping the text onto itself changes nothing.
		if (del && pos >= del.from && pos <= del.to) {
			host.dispatch({selection: EditorSelection.range(del.from, del.to), userEvent: "select.pointer"})
			return
		}
		let changes = state.changes(del ? [del, {from: pos, insert: text}] : {from: pos, insert: text})
		host.dispatch({
			changes,
			selection: EditorSelection.range(changes.mapPos(pos, -1), changes.mapPos(pos, 1)),
			userEvent: del ? "move.drop" : "input.drop"
		})
	}

	private onDragEnd = (e: DragEvent) => {
		this.host.runEventHandlers("dragend", e)
		this.dragged = null
		this.host.surface.draggable = false
		this.host.setDropPos(null)
	}

	destroy() {
		let el = this.host.surface
		el.removeEventListener("dragstart", this.onDragStart)
		el.removeEventListener("dragover", this.onDragOver)
		el.removeEventListener("dragleave", this.onDragLeave)
		el.removeEventListener("drop", this.onDrop)
		el.removeEventListener("dragend", this.onDragEnd)
	}
}
