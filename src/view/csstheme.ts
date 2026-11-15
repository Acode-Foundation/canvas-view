import type {EditorState} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import type {StyleModule} from "style-mod"
import {type PackedColor, parseColor} from "../core/color"
import {canvasBaseModule, themeClassesOf} from "./compat"
import {cssLength, insetFrame, type PathElement, StyleSheetModel} from "./cssresolve"
import type {MarkStyle} from "./decorations"
import {type CanvasThemeSpec, darkTheme, lightTheme, type TokenStyle} from "./theme"

const keywords = /^(inherit|initial|unset|revert|revert-layer|currentcolor)$/i

/// What CodeMirror's CSS (themes, highlight styles, extensions' base
/// themes) says about the things the canvas draws, resolved from the
/// style modules for the elements CodeMirror's DOM editor would have
/// (see `StyleSheetModel`): no element is created or measured.
export class ThemeCSS {
	private editor: PathElement
	private focused: PathElement
	private line: readonly PathElement[]
	private vars = new Map<string, string | null>()
	/// A `var()` couldn't be resolved: the custom property isn't set by
	/// the style modules and the editor isn't in the document yet.
	pending = false

	/// `classes`: the editor element's (theme) classes. `env` reads a
	/// custom property from the real editor element, or returns
	/// undefined when it can't yet.
	constructor(readonly model: StyleSheetModel, classes: string, private env: (name: string) => string | null | undefined) {
		this.editor = ["cm-editor", ...classes.split(" ").filter(c => c && c != "cm-editor")]
		this.focused = [...this.editor, "cm-focused"]
		this.line = [this.editor, ["cm-scroller"], ["cm-content"], ["cm-line"]]
	}

	private lookup = (name: string) => {
		let found = this.vars.get(name)
		if (found === undefined) {
			let read = this.env(name)
			if (read === undefined) {
				this.pending = true
				return null
			}
			this.vars.set(name, found = read)
		}
		return found
	}

	/// A declaration's value with `var()`s substituted; null when it is
	/// absent, a keyword that means "not set here", or unresolved.
	private get(path: readonly PathElement[], prop: string, without = ""): string | null {
		let value = this.model.value(this.model.resolve(path, without)[prop], path, this.lookup)
		return value == null || keywords.test(value) ? null : value
	}

	private under(...rest: PathElement[]) { return [this.editor, ["cm-scroller"], ...rest] }

	/// Whether the style modules have rules for all of these classes
	/// (otherwise their CSS, if any, is the page's own).
	defines(classes: readonly string[]) {
		for (let c of classes) if (c && !this.model.defines(c)) return false
		return true
	}

	/// A highlight class string's style, as on a `span` in a line.
	/// Undefined when the modules don't define the classes.
	token(classes: string): TokenStyle | undefined {
		let list = classes.split(" ").filter(Boolean)
		if (!list.length || !this.defines(list)) return undefined
		let path = [...this.line, ["<span", ...list]]
		let color = this.get(path, "color"), background = this.get(path, "background-color")
		let bg = background ? parseColor(background) : 0
		let weight = this.get(path, "font-weight"), style = this.get(path, "font-style")
		let line = this.get(path, "text-decoration-line") ?? ""
		return {
			color: color ? parseColor(color) : null,
			background: bg >>> 24 ? bg : null,
			bold: weight == "bold" || weight == "bolder" || +weight! >= 600,
			italic: style == "italic" || !!style && style.startsWith("oblique"),
			underline: line.includes("underline"),
			strike: line.includes("line-through")
		}
	}

	/// How an element with these decoration classes is drawn, from the
	/// rules for such a `span` in a line of a focused editor (themes
	/// style matching brackets under `&.cm-focused`). `without`: leave
	/// out rules scoped to this class (CodeMirror's base theme id).
	mark(classes: string, without = ""): MarkStyle | null {
		let list = classes.split(" ").filter(c => c && this.model.defines(c))
		if (!list.length) return null
		let path = [this.focused, ...this.line.slice(1), ["<span", ...list]], get = (prop: string) => this.get(path, prop, without)
		let style: MarkStyle = {}, any = false
		let set = <K extends keyof MarkStyle>(key: K, value: MarkStyle[K] | null | undefined | false) => {
			if (value) { style[key] = value as MarkStyle[K]; any = true }
		}
		set("color", get("color"))
		// A declared `transparent` counts: it takes a default's fill away.
		set("background", get("background-color"))
		let line = get("text-decoration-line") ?? ""
		if (line.includes("underline")) {
			set("underline", get("text-decoration-style") == "wavy" ? "wavy" : "solid")
			set("underlineColor", get("text-decoration-color"))
		}
		set("strike", line.includes("line-through"))
		let weight = get("font-weight"), font = get("font-style")
		set("bold", weight == "bold" || weight == "bolder" || +weight! >= 600)
		set("italic", font == "italic" || !!font && font.startsWith("oblique"))
		let none = get("border-top-style") == "none" || get("outline-style") == "none"
		set("border", this.edge(path, "border-top", without) ?? this.edge(path, "outline", without) ?? (none ? "transparent" : null))
		return any ? style : null
	}

	/// A border or outline's color when it's drawn (a style and a width).
	private edge(path: readonly PathElement[], prop: string, without = ""): string | null {
		let style = this.get(path, prop + "-style", without)
		if (!style || style == "none" || style == "hidden") return null
		let width = this.get(path, prop + "-width", without)
		if (width != null && cssLength(width) === 0) return null
		return this.get(path, prop + "-color", without)
	}

	/// A gutter element's background (classes from markers'
	/// `elementClass`, `gutterLineClass`...) in a gutter with class
	/// `gutter`: a color, null for none, undefined when the modules
	/// don't define the classes.
	gutterElement(gutter: string, classes: string): PackedColor | null | undefined {
		let list = classes.split(" ").filter(Boolean)
		if (!this.defines(list)) return undefined
		let path = this.under(["cm-gutters"], ["cm-gutter", ...gutter.split(" ").filter(Boolean)], ["cm-gutterElement", ...list])
		let bg = this.get(path, "background-color"), color = bg ? parseColor(bg) : 0
		return color >>> 24 ? color : null
	}

	/// The parts of a canvas theme the CSS sets: editor background and
	/// text color, cursor, selection, active line (fill or frame),
	/// gutter and active line number.
	themeSpec(): Partial<CanvasThemeSpec> {
		let spec: Partial<CanvasThemeSpec> = {}, m = this.model
		let set = <K extends keyof CanvasThemeSpec>(key: K, value: CanvasThemeSpec[K] | null | undefined) => {
			if (value != null) spec[key] = value
		}
		let inherited = (path: readonly PathElement[], prop: string) => {
			let value = m.value(m.inherited(path, prop), path, this.lookup)
			return value == null || keywords.test(value) ? null : value
		}
		set("background", this.get([this.editor], "background-color"))
		let content = this.line.slice(0, 3)
		set("foreground", inherited(this.line, "color"))
		let cursor = [this.focused, ["cm-scroller"], ["cm-cursorLayer"], ["cm-cursor", "cm-cursor-primary"]]
		set("cursor", this.get(cursor, "border-left-color") ?? this.get(content, "caret-color"))
		set("selection", this.get([this.focused, ["cm-scroller"], ["cm-selectionLayer"], ["cm-selectionBackground"]], "background-color"))
		let active = [...content, ["cm-line", "cm-activeLine"]]
		set("activeLine", this.get(active, "background-color"))
		let frame = insetFrame(this.get(active, "box-shadow")), outline = this.edge(active, "outline")
		if (frame) {
			spec.activeLineBorder = frame.color
			spec.activeLineBorderWidth = frame.width
		} else if (outline) {
			spec.activeLineBorder = outline
			spec.activeLineBorderWidth = cssLength(this.get(active, "outline-width") ?? "medium") ?? 1
		}
		// A frame alone: no fill, like the DOM's.
		if (spec.activeLineBorder && !spec.activeLine) spec.activeLine = "transparent"
		let gutters = this.under(["cm-gutters"])
		set("gutterBackground", this.get(gutters, "background-color"))
		// Line numbers: themes color `.cm-lineNumbers .cm-gutterElement`.
		let numbers = [...gutters, ["cm-gutter", "cm-lineNumbers"]]
		set("gutterForeground", inherited([...numbers, ["cm-gutterElement"]], "color"))
		set("gutterBorder", this.edge(gutters, "border-right"))
		let activeGutter = [...numbers, ["cm-gutterElement", "cm-activeLineGutter"]]
		set("activeLineGutter", this.get(activeGutter, "background-color"))
		set("gutterActiveForeground", inherited(activeGutter, "color"))
		return spec
	}
}

/// Style modules in cascade order, per `EditorView.styleModule` value.
const cascadeOrders = new WeakMap<readonly StyleModule[], StyleModule[]>()

/// The CSS of a state's style modules (`EditorView.theme`, base themes,
/// highlight styles) for its editor, plus `extra` CSS text after them.
/// `env` reads a custom property the modules don't set (from the
/// editor element; undefined when it can't be read yet).
export function themeCSSOf(state: EditorState, extra?: string,
	env: (name: string) => string | null | undefined = () => null): ThemeCSS {
	let modules = state.facet(EditorView.styleModule)
	let order = cascadeOrders.get(modules)
	// Mounted in this order (see `PluginHost.mountStyles`): the facet's
	// first module has the highest precedence.
	if (!order) cascadeOrders.set(modules, order = (modules as StyleModule[]).concat(canvasBaseModule).reverse())
	return new ThemeCSS(StyleSheetModel.of(order, extra ? [extra] : []), themeClassesOf(state), env)
}

/// The canvas theme a view without a `theme` option draws `state`
/// with: what its CodeMirror themes say, over the built-in theme of
/// their kind (the dark one for a state without a theme).
export function cssThemeSpec(state: EditorState, css: ThemeCSS = themeCSSOf(state)): CanvasThemeSpec {
	let found = css.themeSpec(), dark = state.facet(EditorView.darkTheme)
	// No CodeMirror theme: the default theme, as before.
	if (!dark && found.background == null) return {...darkTheme, ...found}
	let base = dark ? darkTheme : lightTheme
	return {dark, background: base.background, foreground: base.foreground, highlight: base.highlight, ...found}
}
