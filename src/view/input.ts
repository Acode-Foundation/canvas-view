import {type ChangeSet, EditorSelection, type EditorState, type Text, Text as TextClass, type Transaction} from "@codemirror/state"
import {EditorView, runScopeHandlers} from "@codemirror/view"

/// What the input layer needs from the view.
export interface InputHost {
	/// The element the input element is placed in (coordinates are
	/// relative to it).
	readonly surface: HTMLElement
	readonly state: EditorState
	dispatch(...specs: any[]): void
	/// Client rect of the character at `pos`, for IME candidate windows.
	charRect(pos: number): DOMRect | null
	/// Client rect of the cursor (main selection head).
	cursorRect(): DOMRect | null
	onFocusChange(focused: boolean): void
	/// Composition underline ranges (document positions), or null.
	setComposition(ranges: {from: number, to: number, thick: boolean}[] | null): void
	/// Record the timestamp of input that changes what is drawn.
	noteInput(time: number): void
	/// Bring the state's syntax tree up to the screen before handling
	/// input (commands and input handlers read it).
	flushTreeSync(): void
	/// CodeMirror `eventHandlers` from hosted plugins; true when handled.
	runEventHandlers(type: string, event: Event): boolean
}

export interface TextInput {
	readonly element: HTMLElement
	readonly composing: boolean
	readonly kind: "editcontext" | "textarea"
	focus(): void
	blur(): void
	hasFocus(): boolean
	update(trs: readonly Transaction[], startState: EditorState): void
	/// The view switched to an unrelated state (`setState`): drop
	/// positions in the old document.
	setState(state: EditorState): void
	destroy(): void
}

/// Pick the best available input implementation.
export function createInput(host: InputHost, prefer: "auto" | "editcontext" | "textarea" = "auto"): TextInput {
	let hasEC = typeof (window as any).EditContext == "function"
	if (prefer != "textarea" && hasEC) return new EditContextInput(host)
	return new TextareaInput(host)
}

/// Turn editor input (from either implementation) into a transaction,
/// giving `inputHandler` extensions (close brackets, autocomplete
/// triggers...) the first chance, like CodeMirror does.
function applyInput(host: InputHost, view: unknown, from: number, to: number, insert: string,
	selection: {anchor: number, head: number} | null, composing: boolean) {
	let state = host.state
	if (state.readOnly) return
	let main = state.selection.main, multi = state.selection.ranges.length > 1
	// Virtual keyboards delete without key events. With several cursors,
	// such a deletion runs as the key, so the keymap's command applies
	// it at every cursor (CodeMirror does this on Android).
	if (multi && !composing && !insert && main.empty && from < to) {
		let key = to == main.head && from >= to - 2 ? ["Backspace", 8] as const : from == main.head && to <= from + 2 ? ["Delete", 46] as const : null
		if (key && runScopeHandlers(view as any, new KeyboardEvent("keydown", {key: key[0], code: key[0], keyCode: key[1]} as KeyboardEventInit), "editor")) return
	}
	let defaultTr = () => state.update(makeSpec())
	let makeSpec = () => {
		let userEvent = insert ? (composing ? "input.type.compose" : "input.type")
			: to <= main.head ? "delete.backward" : "delete.forward"
		// Typing over the main selection with several cursors applies to all of them.
		if (multi && from == main.from && to == main.to && !composing)
			return {...state.replaceSelection(insert), userEvent, scrollIntoView: true}
		if (multi && (composing || !insert) && to <= main.to + 10 && to >= main.to - 10)
			return {...repeatAtCursors(state, from, to, insert, selection, composing), userEvent, scrollIntoView: true}
		return {
			changes: {from, to, insert},
			selection: selection ? EditorSelection.single(selection.anchor, selection.head) : undefined,
			userEvent, scrollIntoView: true
		}
	}
	if (insert && !composing && from <= to) {
		for (let h of state.facet(EditorView.inputHandler)) if (h(view as any, from, to, insert, defaultTr)) return
	}
	host.dispatch(makeSpec())
}

/// Apply a change made at the main cursor (a composition step, a
/// keyboard's deletion) at the other cursors too, where the replaced
/// text matches at the same offset (CodeMirror's approach for
/// compositions). During a composition, other cursors on the main
/// cursor's line are left alone: changing the text around a
/// composition would abort it.
function repeatAtCursors(state: EditorState, from: number, to: number, insert: string,
	selection: {anchor: number, head: number} | null, composing: boolean) {
	let main = state.selection.main, changes = state.changes({from, to, insert})
	let mainSel = selection && Math.max(selection.anchor, selection.head) <= changes.newLength
		? EditorSelection.range(selection.anchor, selection.head) : null
	let replaced = state.sliceDoc(from, to), offset = main.to - to
	let line = composing ? state.doc.lineAt(main.head) : null
	return state.changeByRange(range => {
		if (range.from == main.from && range.to == main.to) return {changes, range: mainSel ?? range.map(changes)}
		let rTo = range.to - offset, rFrom = rTo - replaced.length
		if (rFrom < 0 || rTo > state.doc.length || state.sliceDoc(rFrom, rTo) != replaced ||
			line && rTo >= line.from && rFrom <= line.to) return {range}
		let rangeChanges = state.changes({from: rFrom, to: rTo, insert}), selOff = range.to - main.to
		return {
			changes: rangeChanges,
			range: mainSel ? EditorSelection.range(Math.max(0, mainSel.anchor + selOff), Math.max(0, mainSel.head + selOff)) : range.map(rangeChanges)
		}
	})
}

/// Run text through `EditorView.clipboardInputFilter` (pasted or
/// dropped text) or `clipboardOutputFilter` (copied, cut or dragged
/// text), in order, like CodeMirror.
export function clipboardFilter(state: EditorState, kind: "input" | "output", text: string) {
	for (let filter of state.facet(kind == "input" ? EditorView.clipboardInputFilter : EditorView.clipboardOutputFilter))
		text = filter(text, state)
	return text
}

/// Shared key and clipboard handling for the input element. Keys run
/// through CodeMirror's keymap engine (the `keymap` facet), so
/// `@codemirror/commands` keymaps work unchanged.
function attachCommon(host: InputHost, view: unknown, el: HTMLElement, isComposing: () => boolean) {
	let onKeyDown = (e: KeyboardEvent) => {
		host.noteInput(e.timeStamp)
		if (isComposing() || e.isComposing || e.keyCode == 229) return
		host.flushTreeSync()
		if (host.runEventHandlers("keydown", e) || runScopeHandlers(view as any, e, "editor")) {
			e.preventDefault()
			return
		}
		// Minimal defaults when no keymap handles these.
		let state = host.state
		if (e.key == "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault()
			let {from, to} = state.selection.main
			applyInput(host, view, from, to, state.lineBreak, null, false)
		} else if (e.key == "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault()
			let {from, to} = state.selection.main
			applyInput(host, view, from, to, "\t", null, false)
		}
	}
	let selected = () => {
		let state = host.state
		let ranges = state.selection.ranges.filter(r => !r.empty)
		if (ranges.length) return {text: ranges.map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak), linewise: false}
		// Copying with an empty selection copies the line (like CodeMirror).
		let line = state.doc.lineAt(state.selection.main.head)
		return {text: line.text + state.lineBreak, linewise: true, from: line.from, to: Math.min(state.doc.length, line.to + 1)}
	}
	let onCopy = (e: ClipboardEvent) => {
		if (host.runEventHandlers(e.type, e)) return
		let sel = selected()
		if (!e.clipboardData) return
		e.preventDefault()
		e.clipboardData.setData("text/plain", clipboardFilter(host.state, "output", sel.text))
		if (e.type == "cut" && !host.state.readOnly) {
			if (sel.linewise) host.dispatch({changes: {from: (sel as any).from, to: (sel as any).to}, userEvent: "delete.cut", scrollIntoView: true})
			else host.dispatch({...host.state.replaceSelection(""), userEvent: "delete.cut", scrollIntoView: true})
		}
	}
	let onPaste = (e: ClipboardEvent) => {
		if (host.runEventHandlers("paste", e)) return
		let text = e.clipboardData?.getData("text/plain")
		if (text == null) return
		e.preventDefault()
		if (host.state.readOnly || !text) return
		// Filters see the clipboard's text as it is, and may empty it
		// (then the selection is deleted), as in CodeMirror.
		text = clipboardFilter(host.state, "input", text).replace(/\r\n?/g, "\n")
		host.dispatch({...host.state.replaceSelection(host.state.toText(text)), userEvent: "input.paste", scrollIntoView: true})
	}
	// For key observers (`crosshairCursor`).
	let onKeyUp = (e: KeyboardEvent) => { host.runEventHandlers("keyup", e) }
	let onFocus = () => host.onFocusChange(true)
	let onBlur = () => host.onFocusChange(false)
	el.addEventListener("keydown", onKeyDown)
	el.addEventListener("keyup", onKeyUp)
	el.addEventListener("copy", onCopy)
	el.addEventListener("cut", onCopy)
	el.addEventListener("paste", onPaste)
	el.addEventListener("focus", onFocus)
	el.addEventListener("blur", onBlur)
	return () => {
		el.removeEventListener("keydown", onKeyDown)
		el.removeEventListener("keyup", onKeyUp)
		el.removeEventListener("copy", onCopy)
		el.removeEventListener("cut", onCopy)
		el.removeEventListener("paste", onPaste)
		el.removeEventListener("focus", onFocus)
		el.removeEventListener("blur", onBlur)
	}
}

function styleInputElement(el: HTMLElement) {
	Object.assign(el.style, {
		position: "absolute", left: "0", top: "0", width: "1px", height: "1em",
		opacity: "0", overflow: "hidden", outline: "none", border: "0", padding: "0",
		margin: "0", resize: "none", whiteSpace: "pre", caretColor: "transparent",
		color: "transparent", background: "transparent", zIndex: "-1", pointerEvents: "none"
	} satisfies Partial<CSSStyleDeclaration>)
	el.setAttribute("autocorrect", "off")
	el.setAttribute("autocapitalize", "off")
	el.setAttribute("spellcheck", "false")
	el.setAttribute("translate", "no")
	el.setAttribute("role", "textbox")
	el.setAttribute("aria-multiline", "true")
}

/// The EditContext window: the editor keeps only part of the document
/// (around the selection) in the context, like CodeMirror.
const MARGIN = 10000
const MIN_MARGIN = 500

/// Input through the EditContext API (Chrome/Android WebView 121+).
/// The approach — a document window mirrored into the context, a
/// pending change that is reconciled with the resulting transaction,
/// and drift tracking during compositions — follows CodeMirror's
/// EditContextManager (MIT, https://codemirror.net).
class EditContextInput implements TextInput {
	readonly kind = "editcontext" as const
	readonly element: HTMLElement
	private context: any
	private from = 0
	private to = 0
	private pending: {from: number, to: number, insert: Text} | null = null
	private composition: {contextBase: number, editorBase: number, drifted: boolean} | null = null
	private composingFlag = false
	private detach: () => void
	private handlers: Record<string, (e: any) => void> = {}

	constructor(private host: InputHost) {
		let el = this.element = document.createElement("div")
		el.className = "cv-input"
		el.tabIndex = 0
		styleInputElement(el)
		host.surface.appendChild(el)
		let state = host.state
		this.resetRange(state)
		let context = this.context = new (window as any).EditContext({
			text: state.doc.sliceString(this.from, this.to),
			selectionStart: this.toContext(Math.max(this.from, Math.min(this.to, state.selection.main.anchor))),
			selectionEnd: this.toContext(state.selection.main.head)
		})
		;(el as any).editContext = context

		this.handlers.textupdate = (e: any) => {
			host.noteInput(e.timeStamp)
			if (!this.composingFlag) host.flushTreeSync()
			let state = host.state, main = state.selection.main
			let from = this.toEditor(e.updateRangeStart), to = this.toEditor(e.updateRangeEnd)
			if (this.composingFlag && !this.composition)
				this.composition = {contextBase: e.updateRangeStart, editorBase: from, drifted: false}
			if (from == this.from && main.anchor < this.from) from = main.anchor
			else if (to == this.to && main.anchor > this.to) to = main.anchor
			let text: string = e.text
			let deletes = to - from > text.length
			let diff = findDiff(state.sliceDoc(from, to), text, (deletes ? main.from : main.to) - from, deletes ? "end" : null)
			let newLen = this.to - this.from + (diff ? text.length - (to - from) : 0)
			let selection = {anchor: this.toEditor(e.selectionStart, newLen), head: this.toEditor(e.selectionEnd, newLen)}
			if (!diff) {
				// Empty change: just a selection update.
				let sel = state.selection.main
				if (selection.anchor != sel.anchor || selection.head != sel.head)
					host.dispatch({selection: EditorSelection.single(selection.anchor, selection.head), userEvent: "select"})
				return
			}
			let change = {from: diff.from + from, to: diff.toA + from, insert: TextClass.of(text.slice(diff.from, diff.toB).split("\n"))}
			this.pending = change
			applyInput(host, host, change.from, change.to, change.insert.toString(), selection, this.composingFlag)
			// If the transaction didn't consume our change, put the
			// context back in sync with the editor.
			if (this.pending) {
				this.revertPending(host.state)
				this.setSelection(host.state)
			}
		}
		this.handlers.characterboundsupdate = (e: any) => {
			let rects: DOMRect[] = [], prev: DOMRect | null = null
			for (let i = this.toEditor(e.rangeStart), end = this.toEditor(e.rangeEnd); i < end; i++) {
				prev = host.charRect(i) ?? prev ?? new DOMRect()
				rects.push(prev)
			}
			context.updateCharacterBounds(e.rangeStart, rects)
		}
		this.handlers.textformatupdate = (e: any) => {
			let ranges: {from: number, to: number, thick: boolean}[] = []
			for (let f of e.getTextFormats()) {
				if (/none/i.test(f.underlineStyle) || /none/i.test(f.underlineThickness)) continue
				let from = this.toEditor(f.rangeStart), to = this.toEditor(f.rangeEnd)
				if (from < to) ranges.push({from, to, thick: !/thin/i.test(f.underlineThickness)})
			}
			host.setComposition(ranges.length ? ranges : null)
		}
		this.handlers.compositionstart = () => { this.composingFlag = true }
		this.handlers.compositionend = () => {
			this.composingFlag = false
			host.setComposition(null)
			let c = this.composition
			this.composition = null
			if (c?.drifted) this.reset(host.state)
		}
		for (let type in this.handlers) context.addEventListener(type, this.handlers[type])
		this.detach = attachCommon(host, host, el, () => this.composingFlag)
		this.updateBounds()
	}

	get composing() { return this.composingFlag }

	focus() { this.element.focus({preventScroll: true}) }
	blur() { this.element.blur() }
	hasFocus() { return document.activeElement == this.element }

	update(trs: readonly Transaction[], startState: EditorState) {
		let state = this.host.state
		let changes: ChangeSet | null = null
		for (let tr of trs) changes = changes ? changes.compose(tr.changes) : tr.changes
		let startSel = startState.selection.main
		let c = this.composition
		if (c && (c.drifted || changes && !changes.touchesRange(startSel.from, startSel.to) &&
			trs.some(tr => !tr.isUserEvent("input.type") && tr.changes.touchesRange(this.from, this.to)))) {
			// An edit elsewhere during a composition: don't touch the
			// context until the composition ends.
			c.drifted = true
			if (changes) c.editorBase = changes.mapPos(c.editorBase)
		} else if (changes && !changes.empty && (!this.applyEdits(changes, state) || !this.rangeIsValid(state))) {
			this.pending = null
			this.reset(state)
		} else if (!this.rangeIsValid(state)) {
			this.reset(state)
		} else {
			if (this.pending) this.revertPending(state)
			this.setSelection(state)
		}
		this.updateBounds()
	}

	/// Mirror document changes into the context with minimal edits.
	private applyEdits(changes: ChangeSet, state: EditorState) {
		let off = 0, abort = false, pending = this.pending
		changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
			if (abort) return
			let dLen = insert.length - (toA - fromA)
			if (pending && toA >= pending.to) {
				if (pending.from == fromA && pending.to == toA && pending.insert.eq(insert)) {
					// The context already holds this change.
					pending = this.pending = null
					off += dLen
					this.to += dLen
					return
				}
				pending = null
				this.revertPending(state)
			}
			fromA += off
			toA += off
			if (toA <= this.from) {
				this.from += dLen
				this.to += dLen
			} else if (fromA < this.to) {
				if (fromA < this.from || toA > this.to || (this.to - this.from) + insert.length > MARGIN * 3) {
					abort = true
					return
				}
				this.context.updateText(this.toContext(fromA), this.toContext(toA), insert.toString())
				this.to += dLen
			}
			off += dLen
		})
		if (pending && !abort) this.revertPending(state)
		return !abort
	}

	private resetRange(state: EditorState) {
		let {head} = state.selection.main
		this.from = Math.max(0, head - MARGIN)
		this.to = Math.min(state.doc.length, head + MARGIN)
	}

	setState(state: EditorState) {
		this.pending = null
		this.composition = null
		this.reset(state)
		this.updateBounds()
	}

	private reset(state: EditorState) {
		this.resetRange(state)
		this.context.updateText(0, this.context.text.length, state.doc.sliceString(this.from, this.to))
		this.setSelection(state)
	}

	private revertPending(state: EditorState) {
		let p = this.pending
		if (!p) return
		this.pending = null
		this.context.updateText(this.toContext(p.from), this.toContext(p.from + p.insert.length), state.doc.sliceString(p.from, p.to))
	}

	private setSelection(state: EditorState) {
		let {main} = state.selection
		let start = this.toContext(Math.max(this.from, Math.min(this.to, main.anchor)))
		let end = this.toContext(main.head)
		if (this.context.selectionStart != start || this.context.selectionEnd != end) this.context.updateSelection(start, end)
	}

	private rangeIsValid(state: EditorState) {
		let {head} = state.selection.main
		return !(this.from > 0 && head - this.from < MIN_MARGIN ||
			this.to < state.doc.length && this.to - head < MIN_MARGIN ||
			this.to - this.from > MARGIN * 3)
	}

	private toEditor(contextPos: number, clipLen = this.to - this.from) {
		contextPos = Math.min(contextPos, clipLen)
		let c = this.composition
		return c && c.drifted ? c.editorBase + (contextPos - c.contextBase) : contextPos + this.from
	}

	private toContext(editorPos: number) {
		let c = this.composition
		return c && c.drifted ? c.contextBase + (editorPos - c.editorBase) : editorPos - this.from
	}

	/// Tell the IME where the editor and the cursor are.
	private updateBounds() {
		let rect = this.host.surface.getBoundingClientRect()
		this.context.updateControlBounds(rect)
		let cursor = this.host.cursorRect()
		if (cursor) {
			this.context.updateSelectionBounds(cursor)
			this.element.style.transform = `translate(${cursor.left - rect.left}px, ${cursor.top - rect.top}px)`
		}
	}

	destroy() {
		for (let type in this.handlers) this.context.removeEventListener(type, this.handlers[type])
		this.detach()
		;(this.element as any).editContext = null
		this.element.remove()
	}
}

/// Fallback for WebViews without EditContext: a hidden textarea that
/// holds the lines around the selection. Its content is diffed on every
/// `input` event (including during IME compositions, so composed text
/// shows immediately) and resynced after outside changes.
class TextareaInput implements TextInput {
	readonly kind = "textarea" as const
	readonly element: HTMLTextAreaElement
	private from = 0
	private value = ""
	private composingFlag = false
	private detach: () => void
	private applying = false

	constructor(private host: InputHost) {
		let el = this.element = document.createElement("textarea")
		el.className = "cv-input"
		styleInputElement(el)
		host.surface.appendChild(el)
		el.addEventListener("input", this.onInput)
		el.addEventListener("compositionstart", this.onCompositionStart)
		el.addEventListener("compositionend", this.onCompositionEnd)
		document.addEventListener("selectionchange", this.onSelectionChange)
		this.detach = attachCommon(host, host, el, () => this.composingFlag)
		this.sync(host.state)
	}

	get composing() { return this.composingFlag }

	focus() { this.element.focus({preventScroll: true}) }
	blur() { this.element.blur() }
	hasFocus() { return document.activeElement == this.element }

	/// Fill the textarea with a few lines around the selection.
	private sync(state: EditorState) {
		let doc = state.doc, main = state.selection.main
		let first = doc.lineAt(main.from), last = doc.lineAt(main.to)
		let from = doc.line(Math.max(1, first.number - 3)).from
		let to = doc.line(Math.min(doc.lines, last.number + 3)).to
		if (to - from > 8000) {
			from = Math.max(first.from, main.from - 4000)
			to = Math.min(last.to, main.to + 4000)
		}
		this.from = from
		this.value = doc.sliceString(from, to)
		let el = this.element
		if (el.value != this.value) el.value = this.value
		el.setSelectionRange(main.from - from, main.to - from, main.head < main.anchor ? "backward" : "forward")
		this.position()
	}

	private position() {
		let rect = this.host.surface.getBoundingClientRect(), cursor = this.host.cursorRect()
		if (cursor) this.element.style.transform = `translate(${cursor.left - rect.left}px, ${cursor.top - rect.top}px)`
	}

	private onInput = (e: Event) => {
		this.host.noteInput(e.timeStamp)
		if (!this.composingFlag) this.host.flushTreeSync()
		let el = this.element, next = el.value, prev = this.value
		if (next == prev) return
		// Prefer a change at the cursor when the diff is ambiguous (typing
		// ")" before ")" must be an insertion before it).
		let main = this.host.state.selection.main, base = this.from
		let deletes = next.length < prev.length
		let diff = findDiff(prev, next, (deletes ? main.from : main.to) - base, deletes ? "end" : null)
		this.value = next
		if (!diff) return
		this.applying = true
		applyInput(this.host, this.host, base + diff.from, base + diff.toA, next.slice(diff.from, diff.toB),
			{anchor: base + el.selectionStart, head: base + el.selectionEnd}, this.composingFlag)
		this.applying = false
		// If the editor changed something else (filters, handlers), resync.
		if (!this.composingFlag && this.host.state.doc.sliceString(this.from, this.from + this.value.length) != this.value)
			this.sync(this.host.state)
	}

	private onCompositionStart = () => { this.composingFlag = true }
	private onCompositionEnd = () => {
		this.composingFlag = false
		this.host.setComposition(null)
		this.sync(this.host.state)
	}

	private onSelectionChange = () => {
		if (!this.hasFocus() || this.composingFlag || this.applying) return
		let el = this.element, state = this.host.state
		let anchor = this.from + (el.selectionDirection == "backward" ? el.selectionEnd : el.selectionStart)
		let head = this.from + (el.selectionDirection == "backward" ? el.selectionStart : el.selectionEnd)
		let main = state.selection.main
		if (anchor != main.anchor || head != main.head)
			this.host.dispatch({selection: EditorSelection.single(Math.min(anchor, state.doc.length), Math.min(head, state.doc.length)), userEvent: "select"})
	}

	update(trs: readonly Transaction[]) {
		if (this.applying || this.composingFlag) return
		if (trs.some(tr => tr.docChanged || tr.selection)) this.sync(this.host.state)
	}

	setState(state: EditorState) { this.sync(state) }

	destroy() {
		let el = this.element
		el.removeEventListener("input", this.onInput)
		el.removeEventListener("compositionstart", this.onCompositionStart)
		el.removeEventListener("compositionend", this.onCompositionEnd)
		document.removeEventListener("selectionchange", this.onSelectionChange)
		this.detach()
		el.remove()
	}
}

/// Find the minimal change between `a` and `b`, preferring a change
/// touching `preferredPos` (the cursor). Returns null when equal.
/// From CodeMirror's view package (MIT, https://codemirror.net).
function findDiff(a: string, b: string, preferredPos: number, preferredSide: string | null): {from: number, toA: number, toB: number} | null {
	let minLen = Math.min(a.length, b.length)
	let from = 0
	while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++
	if (from == minLen && a.length == b.length) return null
	let toA = a.length, toB = b.length
	while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) {
		toA--
		toB--
	}
	if (preferredSide == "end") {
		let adjust = Math.max(0, from - Math.min(toA, toB))
		preferredPos -= toA + adjust - from
	}
	if (toA < from && a.length < b.length) {
		let move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0
		from -= move
		toB = from + (toB - toA)
		toA = from
	} else if (toB < from) {
		let move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0
		from -= move
		toA = from + (toA - toB)
		toB = from
	}
	return {from, toA, toB}
}
