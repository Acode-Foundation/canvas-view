import type {HighlightStyle} from "@codemirror/language"
import {type Highlighter, tagHighlighter, tags as t, type Tag} from "@lezer/highlight"
import {type PackedColor, parseColor} from "../core/color"
import type {MarkStyle} from "./decorations"

/// A syntax style rule, in the same shape as CodeMirror's
/// `HighlightStyle.define` specs (only the properties a canvas can
/// draw are used).
export interface TokenStyleSpec {
	tag: Tag | readonly Tag[]
	color?: string
	backgroundColor?: string
	fontWeight?: string | number
	fontStyle?: string
	textDecoration?: string
	[prop: string]: unknown
}

export interface CanvasThemeSpec {
	dark?: boolean
	background: string
	foreground: string
	gutterBackground?: string
	gutterForeground?: string
	gutterActiveForeground?: string
	gutterBorder?: string
	activeLine?: string
	activeLineGutter?: string
	selection?: string
	cursor?: string
	/// Touch selection handles (defaults to the cursor color).
	selectionHandle?: string
	scrollbar?: string
	/// Indent guides, and the active one (the block around the cursor).
	indentGuide?: string
	activeIndentGuide?: string
	/// Whitespace markers and the trailing-space highlight.
	whitespace?: string
	trailingSpace?: string
	/// Sticky scroll lines' background (defaults to the background) and
	/// the shadow under them.
	stickyBackground?: string
	stickyShadow?: string
	/// Syntax colors: a CodeMirror HighlightStyle (its specs are read
	/// directly) or a list of specs.
	highlight?: HighlightStyle | readonly TokenStyleSpec[]
	/// How decoration classes are drawn (e.g. `"cm-searchMatch":
	/// {background: "#ff03"}`), overriding the built-in defaults for
	/// CodeMirror's classes.
	classes?: Record<string, MarkStyle>
}

export interface TokenStyle {
	color: PackedColor | null
	background: PackedColor | null
	bold: boolean
	italic: boolean
	underline: boolean
	strike: boolean
}

/// A resolved theme: packed colors plus a highlighter mapping syntax
/// tags to token styles.
export class CanvasTheme {
	readonly dark: boolean
	readonly background: PackedColor
	readonly foreground: PackedColor
	readonly gutterBackground: PackedColor
	readonly gutterForeground: PackedColor
	readonly gutterActiveForeground: PackedColor
	readonly gutterBorder: PackedColor
	readonly activeLine: PackedColor
	readonly activeLineGutter: PackedColor
	readonly selection: PackedColor
	readonly cursor: PackedColor
	readonly selectionHandle: PackedColor
	readonly scrollbar: PackedColor
	readonly indentGuide: PackedColor
	readonly whitespace: PackedColor
	readonly trailingSpace: PackedColor
	readonly activeIndentGuide: PackedColor
	readonly stickyBackground: PackedColor
	readonly stickyShadow: PackedColor
	readonly highlighter: Highlighter
	private specs: readonly TokenStyleSpec[]
	private resolved = new Map<string, TokenStyle>()

	constructor(readonly spec: CanvasThemeSpec) {
		let c = (v: string | undefined, fallback: string) => parseColor(v ?? fallback)
		this.dark = spec.dark ?? true
		this.background = c(spec.background, "#000")
		this.foreground = c(spec.foreground, "#fff")
		this.gutterBackground = c(spec.gutterBackground, spec.background)
		this.gutterForeground = c(spec.gutterForeground, this.dark ? "#6b717d" : "#999")
		this.gutterActiveForeground = c(spec.gutterActiveForeground, spec.foreground)
		this.gutterBorder = c(spec.gutterBorder, "transparent")
		this.activeLine = c(spec.activeLine, this.dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)")
		this.activeLineGutter = c(spec.activeLineGutter, spec.activeLine ?? "transparent")
		this.selection = c(spec.selection, this.dark ? "rgba(62,68,81,0.9)" : "rgba(170,200,255,0.6)")
		this.cursor = c(spec.cursor, this.dark ? "#528bff" : "#000")
		this.selectionHandle = spec.selectionHandle ? c(spec.selectionHandle, "#528bff") : this.cursor
		this.scrollbar = c(spec.scrollbar, this.dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)")
		this.whitespace = c(spec.whitespace, this.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.25)")
		this.trailingSpace = c(spec.trailingSpace, "rgba(255,77,77,0.22)")
		this.indentGuide = c(spec.indentGuide, this.dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.1)")
		this.activeIndentGuide = c(spec.activeIndentGuide, this.dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.3)")
		this.stickyBackground = c(spec.stickyBackground, spec.background)
		this.stickyShadow = c(spec.stickyShadow, this.dark ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.18)")
		let h = spec.highlight
		this.specs = !h ? [] : "specs" in h ? h.specs as readonly TokenStyleSpec[] : h
		this.highlighter = tagHighlighter(this.specs.map((s, i) => ({tag: s.tag, class: "" + i})))
	}

	/// The theme's style for a decoration class, if any.
	classStyle(cls: string): MarkStyle | null {
		return this.spec.classes?.[cls] ?? null
	}

	/// Resolve a class string produced by `highlighter` (space-separated
	/// spec indices) into a token style. Later specs win.
	tokenStyle(classes: string): TokenStyle {
		let found = this.resolved.get(classes)
		if (found) return found
		let style: TokenStyle = {color: null, background: null, bold: false, italic: false, underline: false, strike: false}
		for (let id of classes.split(" ")) {
			let s = this.specs[+id]
			if (!s) continue
			if (s.color) style.color = parseColor(s.color)
			if (s.backgroundColor) style.background = parseColor(s.backgroundColor)
			if (s.fontWeight != null) style.bold = s.fontWeight == "bold" || +s.fontWeight >= 600
			if (s.fontStyle) style.italic = s.fontStyle == "italic" || s.fontStyle == "oblique"
			if (s.textDecoration) {
				style.underline = s.textDecoration.includes("underline")
				style.strike = s.textDecoration.includes("line-through")
			}
		}
		this.resolved.set(classes, style)
		return style
	}
}

/// A dark theme with One Dark-like colors.
export const darkTheme: CanvasThemeSpec = {
	dark: true,
	background: "#282c34",
	foreground: "#abb2bf",
	gutterBackground: "#282c34",
	gutterForeground: "#5c6370",
	gutterActiveForeground: "#abb2bf",
	activeLine: "#2c313c",
	activeLineGutter: "#2c313c",
	selection: "#3e4451",
	cursor: "#528bff",
	highlight: [
		{tag: t.keyword, color: "#c678dd"},
		{tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#e06c75"},
		{tag: [t.function(t.variableName), t.labelName], color: "#61afef"},
		{tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#d19a66"},
		{tag: [t.definition(t.name), t.separator], color: "#abb2bf"},
		{tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#e5c07b"},
		{tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#56b6c2"},
		{tag: [t.meta, t.comment], color: "#7d8799", fontStyle: "italic"},
		{tag: t.strong, fontWeight: "bold"},
		{tag: t.emphasis, fontStyle: "italic"},
		{tag: t.strikethrough, textDecoration: "line-through"},
		{tag: t.link, color: "#7d8799", textDecoration: "underline"},
		{tag: t.heading, fontWeight: "bold", color: "#e06c75"},
		{tag: [t.atom, t.bool, t.special(t.variableName)], color: "#d19a66"},
		{tag: [t.processingInstruction, t.string, t.inserted], color: "#98c379"},
		{tag: t.invalid, color: "#ffffff"},
		{tag: t.tagName, color: "#e06c75"},
		{tag: t.attributeName, color: "#d19a66"}
	]
}

export const lightTheme: CanvasThemeSpec = {
	dark: false,
	background: "#ffffff",
	foreground: "#383a42",
	gutterBackground: "#f5f5f5",
	gutterForeground: "#9d9d9f",
	gutterActiveForeground: "#383a42",
	activeLine: "#f2f6ff",
	activeLineGutter: "#e8edf7",
	selection: "#c9d8f5",
	cursor: "#526fff",
	highlight: [
		{tag: t.keyword, color: "#a626a4"},
		{tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#e45649"},
		{tag: [t.function(t.variableName), t.labelName], color: "#4078f2"},
		{tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#986801"},
		{tag: [t.definition(t.name), t.separator], color: "#383a42"},
		{tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#c18401"},
		{tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#0184bc"},
		{tag: [t.meta, t.comment], color: "#a0a1a7", fontStyle: "italic"},
		{tag: t.strong, fontWeight: "bold"},
		{tag: t.emphasis, fontStyle: "italic"},
		{tag: t.heading, fontWeight: "bold", color: "#e45649"},
		{tag: [t.atom, t.bool, t.special(t.variableName)], color: "#986801"},
		{tag: [t.processingInstruction, t.string, t.inserted], color: "#50a14f"},
		{tag: t.tagName, color: "#e45649"},
		{tag: t.attributeName, color: "#986801"}
	]
}
