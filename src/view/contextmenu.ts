import {EditorSelection} from "@codemirror/state"
import {inputHandlers, type InputHost} from "./input"

/// What the context menu needs from the view besides the input host.
export interface MenuControl {
	/// Whether the editor accepts edits (`EditorView.editable` and not
	/// read-only): the menu offers Cut and Paste only then.
	writable(): boolean
	/// Give focus back to the input element.
	focus(): void
	/// Hold focus notifications (see `CanvasView.holdFocus`).
	holdFocus(hold: boolean): void
}

/// Pads around the selected text, so "Select all" changes the
/// stand-in's selection even when it already selects all of its text.
const PAD = "​"

/// The browser's own context menu for mouse right-clicks.
///
/// A menu offers Cut, Copy and Paste only over an editable element
/// holding a selection, and the canvas is neither (the EditContext
/// element holds no DOM text either). So, like Ace, a right press puts
/// a transparent textarea under the pointer: the `contextmenu` event
/// that follows hits it, the view fills it with the selected text
/// (selected) and focuses it, and the browser shows its editing menu.
/// The menu's commands arrive as `copy`/`cut`/`paste` events and a
/// selection change ("Select all") on that textarea, handled like the
/// input element's, after which focus goes back to the input. Focus
/// notifications are held meanwhile, so plugins see no blur.
export class NativeContextMenu {
	private el: HTMLTextAreaElement | null = null
	/// A right press placed the stand-in; the menu event hasn't come yet.
	private armed = false
	/// The stand-in holds focus while the browser's menu is open.
	private open = false
	private disarmTimer = -1
	private handlers: ReturnType<typeof inputHandlers>

	constructor(private host: InputHost, view: unknown, private ctl: MenuControl) {
		this.handlers = inputHandlers(host, view, () => false)
	}

	get focused() { return this.open && this.el != null && document.activeElement == this.el }

	/// Whether the event is the menu of a press `arm` prepared.
	owns(e: Event) { return this.armed && this.el != null && e.target == this.el }

	/// A mouse right press at client (x, y): put the stand-in under the
	/// pointer so the coming `contextmenu` event targets it.
	arm(x: number, y: number) {
		this.close(false)
		let el = this.el ?? this.create(), rect = this.host.surface.getBoundingClientRect()
		el.style.transform = `translate(${x - rect.left - 8}px, ${y - rect.top - 8}px)`
		el.style.pointerEvents = "auto"
		el.style.display = ""
		this.armed = true
		// On Windows and Linux the menu event follows the release; if
		// none comes (the press was cancelled), stop catching the pointer.
		clearTimeout(this.disarmTimer)
		this.disarmTimer = window.setTimeout(() => { if (!this.open) this.close(false) }, 1000)
	}

	/// Show the browser's menu for the current selection: called from
	/// the `contextmenu` event of an armed press, which must not be
	/// cancelled.
	show() {
		let el = this.el!, state = this.host.state
		clearTimeout(this.disarmTimer)
		let text = state.selection.ranges.filter(r => !r.empty).map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak)
		el.value = PAD + text + PAD
		el.readOnly = !this.ctl.writable()
		this.open = true
		this.ctl.holdFocus(true)
		el.focus({preventScroll: true})
		el.setSelectionRange(1, 1 + text.length)
		// Its hit area is no longer needed: later presses go to the editor.
		el.style.pointerEvents = "none"
	}

	/// Hide the stand-in. With `refocus`, focus goes back to the input
	/// element (after a menu command, or a key typed with it focused).
	close(refocus: boolean) {
		let el = this.el
		if (!el || !this.armed && !this.open) return
		let wasOpen = this.open
		this.armed = this.open = false
		clearTimeout(this.disarmTimer)
		if (refocus && document.activeElement == el) this.ctl.focus()
		el.style.pointerEvents = "none"
		el.style.display = "none"
		el.value = ""
		if (wasOpen) this.ctl.holdFocus(false)
	}

	private create() {
		let el = this.el = document.createElement("textarea")
		el.className = "cv-menu-input"
		el.tabIndex = -1
		el.setAttribute("aria-hidden", "true")
		el.setAttribute("autocorrect", "off")
		el.setAttribute("autocapitalize", "off")
		el.setAttribute("spellcheck", "false")
		Object.assign(el.style, {
			position: "absolute", left: "0", top: "0", width: "16px", height: "16px",
			opacity: "0", overflow: "hidden", outline: "none", border: "0", padding: "0",
			margin: "0", resize: "none", whiteSpace: "pre", caretColor: "transparent",
			color: "transparent", background: "transparent", zIndex: "10", cursor: "text",
			pointerEvents: "none", display: "none"
		} satisfies Partial<CSSStyleDeclaration>)
		el.addEventListener("copy", this.onCopy)
		el.addEventListener("cut", this.onCopy)
		el.addEventListener("paste", this.onPaste)
		el.addEventListener("beforeinput", this.onBeforeInput)
		el.addEventListener("keydown", this.onKeyDown)
		el.addEventListener("blur", this.onBlur)
		document.addEventListener("selectionchange", this.onSelectionChange)
		this.host.surface.appendChild(el)
		return el
	}

	private onCopy = (e: ClipboardEvent) => {
		this.handlers.onCopy(e)
		this.close(true)
	}

	private onPaste = (e: ClipboardEvent) => {
		this.handlers.onPaste(e)
		e.preventDefault()
		this.close(true)
	}

	/// Other editing commands from the menu (an emoji picker's text,
	/// "Undo", "Delete"...) must not edit the stand-in. Inserted text
	/// replaces the selection, as typed text would.
	private onBeforeInput = (e: InputEvent) => {
		e.preventDefault()
		let state = this.host.state
		if (this.ctl.writable() && (e.inputType == "insertText" || e.inputType == "insertReplacementText") && e.data)
			this.host.dispatch({...state.replaceSelection(e.data), userEvent: "input.type", scrollIntoView: true})
		this.close(true)
	}

	/// "Select all" selects the stand-in's padding too.
	private onSelectionChange = () => {
		let el = this.el
		if (!this.open || !el || document.activeElement != el) return
		if (el.selectionStart == 0 && el.selectionEnd == el.value.length) {
			this.host.dispatch({selection: EditorSelection.single(0, this.host.state.doc.length), userEvent: "select"})
			this.close(true)
		}
	}

	/// A key after the menu was dismissed: focus moves back to the input
	/// element, which receives the text the key produces, and the key
	/// itself runs through the keymap as usual.
	private onKeyDown = (e: KeyboardEvent) => {
		this.close(true)
		this.handlers.onKeyDown(e)
	}

	private onBlur = () => {
		// The window losing focus (to the menu, on some systems) leaves
		// the stand-in focused within the page: keep it.
		if (document.hasFocus()) this.close(false)
	}

	destroy() {
		clearTimeout(this.disarmTimer)
		document.removeEventListener("selectionchange", this.onSelectionChange)
		this.el?.remove()
	}
}
