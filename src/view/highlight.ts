import {HighlightStyle, syntaxHighlighting} from "@codemirror/language"
import type {EditorState, Facet} from "@codemirror/state"
import type {Highlighter} from "@lezer/highlight"
import {parseColor} from "../core/color"
import type {FontSpec} from "../core/metrics"
import {findProvider} from "./compat"
import type {TokenStyle} from "./theme"

/// CodeMirror's (unexported) highlighter facets, read from probe
/// `syntaxHighlighting` extensions.
function highlighterFacet(fallback: boolean): Facet<Highlighter, readonly Highlighter[]> | null {
	let probe = HighlightStyle.define([])
	return findProvider(syntaxHighlighting(probe, {fallback}), p => p.value === probe)?.facet ?? null
}

const mainFacet = highlighterFacet(false), fallbackFacet = highlighterFacet(true)

/// The highlighters CodeMirror styles the state's syntax tree with (as
/// in its `getHighlighters`), or null when there are none.
export function stateHighlighters(state: EditorState): readonly Highlighter[] | null {
	if (!mainFacet) return null
	let main = state.facet(mainFacet)
	if (main.length) return main
	// The fallback facet combines to null when empty.
	let fallback = fallbackFacet ? state.facet(fallbackFacet) as readonly Highlighter[] | null : null
	return fallback?.length ? fallback : null
}

export function sameHighlighters(a: readonly Highlighter[] | null, b: readonly Highlighter[] | null) {
	return a == b || !!a && !!b && a.length == b.length && a.every((h, i) => h == b[i])
}

/// Resolves highlight class strings to token styles from the computed
/// style of a hidden token inside the editor, so they come from the
/// same CSS (highlight style modules, editor themes) that styles
/// CodeMirror's DOM editor.
export class ClassStyleReader {
	private line: HTMLElement | null = null
	private token: HTMLElement | null = null
	private probe: HTMLElement | null = null

	constructor(private parent: HTMLElement) {}

	/// Null when styles can't be read yet (the editor isn't in the
	/// document).
	read(classes: string): TokenStyle | null {
		if (!this.connect()) return null
		this.token!.className = classes
		let t = getComputedStyle(this.token!), l = getComputedStyle(this.line!)
		let background = parseColor(t.backgroundColor)
		let decoration = t.textDecorationLine
		return {
			color: t.color == l.color ? null : parseColor(t.color),
			background: background >>> 24 ? background : null,
			bold: +t.fontWeight >= 600 && !(+l.fontWeight >= 600),
			italic: t.fontStyle != l.fontStyle && t.fontStyle != "normal",
			underline: decoration.includes("underline"),
			strike: decoration.includes("line-through")
		}
	}

	private connect() {
		if (!this.parent.isConnected) return false
		if (!this.token || this.line!.parentNode!.parentNode != this.parent) {
			let content = document.createElement("div")
			content.className = "cm-content"
			content.setAttribute("aria-hidden", "true")
			Object.assign(content.style, {
				position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none",
				whiteSpace: "pre", contain: "strict", width: "0", height: "0", overflow: "hidden"
			} satisfies Partial<CSSStyleDeclaration>)
			this.line = content.appendChild(document.createElement("div"))
			this.line.className = "cm-line"
			this.token = this.line.appendChild(document.createElement("span"))
			this.token.textContent = "x"
			this.probe = content.appendChild(document.createElement("div"))
			this.probe.className = "cm-line"
			this.probe.textContent = "x"
			this.parent.appendChild(content)
		}
		return true
	}

	/// The height of a `.cm-line` in this font, in CSS pixels, with the
	/// CSS line height unless one is given (a multiple of the size).
	/// CodeMirror measures its line height the same way, so this is the
	/// DOM's exact value (Chromium's 1/64 px units, half-leading
	/// rounding). Null when the editor isn't laid out.
	lineHeight(font: FontSpec, multiple: number | null): number | null {
		if (!this.connect()) return null
		let style = this.probe!.style
		style.fontFamily = font.family
		style.fontSize = font.size + "px"
		style.lineHeight = multiple == null ? "" : String(multiple)
		let height = this.probe!.getBoundingClientRect().height
		return height > 0 ? height : null
	}

	/// Whether the editor's CSS leaves ligatures on in `.cm-line` text.
	/// Coding fonts draw them as contextual alternates (`calt`), so
	/// `no-contextual` or `"calt" 0` turns them off as well as `none`.
	/// Null when the editor isn't in the document.
	ligatures(): boolean | null {
		if (!this.connect()) return null
		let style = getComputedStyle(this.probe!), variant = style.fontVariantLigatures
		return !(variant == "none" || variant.includes("no-contextual") || /"calt" 0\b/.test(style.fontFeatureSettings))
	}

	destroy() {
		;(this.line?.parentNode as HTMLElement | null)?.remove()
		this.line = this.token = this.probe = null
	}
}
