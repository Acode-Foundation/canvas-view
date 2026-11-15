/// A small CSS cascade over CodeMirror's style modules, without the
/// DOM: `EditorView.theme`, base themes and highlight styles are all
/// `StyleModule`s whose rules are plain class selectors, so what the
/// browser would compute for an element of CodeMirror's editor DOM can
/// be found by matching those rules against a *virtual* element path
/// (lists of classes, outermost first). The canvas draws no such
/// elements; reading their styles back from hidden replicas cost a
/// style recalculation per read.
///
/// Understood: class, tag and universal selectors with descendant and
/// child combinators, selector lists, specificity, source order,
/// `!important`, custom properties and `var()`. Rules with anything
/// else (pseudo-classes and -elements, attributes, ids, sibling
/// combinators, at-rules) are skipped: they can't apply to a drawn
/// element's resting state, or need a real element.

/// A virtual element: its classes, and optionally its tag as `"<span"`.
export type PathElement = readonly string[]
export type Declarations = {readonly [prop: string]: string}

interface Rule {
	/// Compound selectors, outermost first: each a list of tokens (class
	/// names, `"<tag"`); empty for `*`.
	parts: readonly (readonly string[])[]
	/// `child[i]`: part `i` must be the parent of part `i + 1`.
	child: readonly boolean[]
	specificity: number
	order: number
	decls: Declarations
	important: Declarations | null
}

interface ParsedSource {
	rules: Rule[]
	/// Every class a selector mentions, in skipped rules too.
	classes: Set<string>
}

/// Split at `sep` outside parentheses, brackets and strings.
export function splitTop(text: string, sep: string): string[] {
	let out: string[] = [], depth = 0, quote = "", start = 0
	for (let i = 0; i < text.length; i++) {
		let ch = text[i]
		if (quote) {
			if (ch == "\\") i++
			else if (ch == quote) quote = ""
		} else if (ch == '"' || ch == "'") quote = ch
		else if (ch == "(" || ch == "[") depth++
		else if (ch == ")" || ch == "]") depth--
		else if (ch == sep && depth <= 0) {
			out.push(text.slice(start, i))
			start = i + 1
		}
	}
	out.push(text.slice(start))
	return out
}

function words(value: string) {
	return splitTop(value.trim().replace(/\s+/g, " "), " ").filter(Boolean)
}

const lengthRe = /^[+-]?(\d*\.)?\d+([a-z%]*)$/i
const lineStyles = new Set(["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset", "none", "hidden", "wavy"])
const widthWords = new Set(["thin", "medium", "thick", "auto", "from-font"])
const decorationLines = new Set(["underline", "line-through", "overline", "none", "blink"])
const backgroundWords = new Set(["none", "repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round", "scroll", "fixed", "local",
	"center", "top", "left", "right", "bottom", "border-box", "padding-box", "content-box", "cover", "contain", "auto", "/"])

/// A length in CSS pixels (`em` relative to `em` px), or null.
export function cssLength(value: string, em = 16): number | null {
	let m = lengthRe.exec(value.trim())
	if (!m) return widthWords.has(value) ? value == "thin" ? 1 : value == "thick" ? 5 : 3 : null
	let n = parseFloat(value), unit = m[2].toLowerCase()
	return unit == "" || unit == "px" ? n : unit == "em" || unit == "rem" ? n * em : unit == "pt" ? n * 4 / 3 : null
}

/// Write a declaration as longhands, so that the cascade between a
/// shorthand and its longhands (`background` after `background-color`)
/// is decided per property like in a browser.
function expand(prop: string, value: string, out: {[prop: string]: string}) {
	out[prop] = value
	if (prop == "background") {
		let color = "transparent"
		for (let w of words(splitTop(value, ",").pop()!)) {
			if (backgroundWords.has(w) || lengthRe.test(w) || /^(url|[a-z-]*gradient|image-set|image|cross-fade|element)\(/i.test(w)) continue
			color = w
		}
		out["background-color"] = color
	} else if (/^(border|outline)(-(top|right|bottom|left))?$/.test(prop)) {
		let color = "currentcolor", width = "medium", style = "none"
		for (let w of words(value)) {
			if (lineStyles.has(w)) style = w
			else if (lengthRe.test(w) || widthWords.has(w)) width = w
			else color = w
		}
		for (let side of prop == "border" ? ["border-top", "border-right", "border-bottom", "border-left"] : [prop]) {
			out[side + "-color"] = color
			out[side + "-width"] = width
			out[side + "-style"] = style
		}
	} else if (prop == "border-color" || prop == "border-width" || prop == "border-style") {
		let w = words(value), kind = prop.slice(6)
		let sides = [w[0], w[1] ?? w[0], w[2] ?? w[0], w[3] ?? w[1] ?? w[0]]
		;["top", "right", "bottom", "left"].forEach((side, i) => out[`border-${side}${kind}`] = sides[i])
	} else if (prop == "text-decoration") {
		let line: string[] = [], style = "solid", color = "currentcolor"
		for (let w of words(value)) {
			if (decorationLines.has(w)) line.push(w)
			else if (lineStyles.has(w)) style = w
			else if (!lengthRe.test(w) && !widthWords.has(w)) color = w
		}
		out["text-decoration-line"] = line.join(" ") || "none"
		out["text-decoration-style"] = style
		out["text-decoration-color"] = color
	}
}

function parseDeclarations(body: string) {
	let decls: {[prop: string]: string} = {}, important: {[prop: string]: string} | null = null
	for (let d of splitTop(body, ";")) {
		let colon = d.indexOf(":")
		if (colon < 1) continue
		let prop = d.slice(0, colon).trim(), value = d.slice(colon + 1).trim()
		if (!prop.startsWith("--")) prop = prop.toLowerCase()
		if (/!\s*important$/i.test(value)) expand(prop, value.replace(/\s*!\s*important$/i, ""), important ??= {})
		else expand(prop, value, decls)
	}
	return {decls, important}
}

const classRe = /\.((?:[^\s.#:[\]>+~,*()\\{}]|\\.)+)/g

/// One complex selector, or null when it uses something unsupported.
function parseSelector(sel: string): {parts: string[][], child: boolean[], specificity: number} | null {
	let parts: string[][] = [], child: boolean[] = [], specificity = 0
	let cur: string[] | null = null, pendingChild = false, i = 0, n = sel.length
	let open = () => {
		if (!cur) {
			if (parts.length) child.push(pendingChild)
			pendingChild = false
			parts.push(cur = [])
		}
		return cur
	}
	while (i < n) {
		let ch = sel[i]
		if (ch == " " || ch == "\n" || ch == "\t") { cur = null; i++ }
		else if (ch == ">") {
			if (!parts.length || pendingChild) return null
			cur = null
			pendingChild = true
			i++
		} else if (ch == "*") { open(); i++ }
		else if (ch == ".") {
			let end = i + 1
			while (end < n && !" \n\t.#:[]>+~,*()\\".includes(sel[end])) end++
			if (end == i + 1 || sel[end] == "\\") return null
			open().push(sel.slice(i + 1, end))
			specificity += 256
			i = end
		} else if (/[a-zA-Z]/.test(ch)) {
			let end = i + 1
			while (end < n && /[\w-]/.test(sel[end])) end++
			// A tag comes first in its compound.
			if (cur) return null
			open().push("<" + sel.slice(i, end).toLowerCase())
			specificity += 1
			i = end
		} else return null
	}
	if (!parts.length || pendingChild) return null
	return {parts, child, specificity}
}

/// Parse CSS text into rules. At-rules (media queries, keyframes) are
/// skipped along with their blocks.
function parseCSS(text: string): ParsedSource {
	let rules: Rule[] = [], classes = new Set<string>()
	let i = 0, n = text.length
	while (i < n) {
		let open = text.indexOf("{", i)
		if (open < 0) break
		let depth = 1, close = open + 1, quote = ""
		for (; close < n && depth; close++) {
			let ch = text[close]
			if (quote) {
				if (ch == "\\") close++
				else if (ch == quote) quote = ""
			} else if (ch == '"' || ch == "'") quote = ch
			else if (ch == "{") depth++
			else if (ch == "}") depth--
		}
		let prelude = text.slice(i, open).replace(/\/\*[^]*?\*\//g, "").trim()
		i = close
		if (!prelude) continue
		// In a skipped at-rule's block too: those classes have rules.
		let mentions = prelude[0] == "@" ? text.slice(open, close) : prelude
		for (let m; m = classRe.exec(mentions);) classes.add(m[1])
		if (prelude[0] == "@") continue
		let parsed: ReturnType<typeof parseDeclarations> | null = null
		for (let sel of splitTop(prelude, ",")) {
			let s = parseSelector(sel.trim())
			if (!s) continue
			parsed ??= parseDeclarations(text.slice(open + 1, close - 1).replace(/\/\*[^]*?\*\//g, ""))
			rules.push({...s, order: 0, decls: parsed.decls, important: parsed.important})
		}
	}
	return {rules, classes}
}

/// What `StyleSheetModel.of` takes: style modules (anything with
/// style-mod's `getRules()`) or CSS text.
export type StyleSource = {getRules(): string} | string

// Parsed once per module, for every view, document and theme
// combination it's part of (editor tabs share most of their modules).
const parsedModules = new WeakMap<object, ParsedSource>()
const parsedText = new Map<string, ParsedSource>()

function parseSource(source: StyleSource): ParsedSource {
	if (typeof source == "string") {
		let found = parsedText.get(source)
		if (!found) {
			if (parsedText.size > 32) parsedText.clear()
			parsedText.set(source, found = parseCSS(source))
		}
		return found
	}
	let found = parsedModules.get(source)
	if (!found) parsedModules.set(source, found = parseCSS(source.getRules()))
	return found
}

const models = new WeakMap<object, {extra: readonly StyleSource[], model: StyleSheetModel}[]>()

function includes(element: PathElement, part: readonly string[]) {
	for (let token of part) if (!element.includes(token)) return false
	return true
}

function matches(rule: Rule, path: readonly PathElement[], j: number, i: number): boolean {
	if (!includes(path[i], rule.parts[j])) return false
	if (j == 0) return true
	if (rule.child[j - 1]) return i > 0 && matches(rule, path, j - 1, i - 1)
	for (let k = i - 1; k >= 0; k--) if (matches(rule, path, j - 1, k)) return true
	return false
}

const empty: Declarations = Object.freeze({})

/// The rules of a set of style sources, in cascade order (later
/// sources win over earlier ones at equal specificity).
export class StyleSheetModel {
	/// Rules by a class of their last compound selector ("" for those
	/// without one), so a lookup only tries rules that may match.
	private byClass = new Map<string, Rule[]>()
	private classes = new Set<string>()
	private cache = new Map<string, Declarations>()
	readonly ruleCount: number

	constructor(sources: readonly StyleSource[]) {
		let order = 0
		for (let source of sources) {
			let parsed = parseSource(source)
			for (let cls of parsed.classes) this.classes.add(cls)
			for (let rule of parsed.rules) {
				// Parsed rules are shared between models: order is per model.
				let own = {...rule, order: order++}
				let last = rule.parts[rule.parts.length - 1], key = ""
				for (let token of last) if (token[0] != "<") { key = token; break }
				let bucket = this.byClass.get(key)
				if (bucket) bucket.push(own)
				else this.byClass.set(key, [own])
			}
		}
		this.ruleCount = order
	}

	/// The model for `modules` (lowest precedence first) followed by
	/// `extra` sources, cached on the identity of the `modules` array (a
	/// facet value: the same array until the configuration changes).
	static of(modules: readonly StyleSource[], extra: readonly StyleSource[] = []): StyleSheetModel {
		let list = models.get(modules)
		if (!list) models.set(modules, list = [])
		for (let entry of list)
			if (entry.extra.length == extra.length && entry.extra.every((e, i) => e === extra[i])) return entry.model
		let model = new StyleSheetModel(modules.concat(extra))
		list.push({extra, model})
		return model
	}

	/// Whether any rule's selector mentions this class (also rules this
	/// model can't apply, like `.x:hover`). Classes no source mentions
	/// are styled elsewhere, if at all (page stylesheets).
	defines(cls: string) { return this.classes.has(cls) }

	/// The declarations that apply to the last element of `path`
	/// (longhands for the shorthands this file expands), not including
	/// inherited ones. With `without`, rules scoped to that class (a
	/// rule whose first compound selector has it) are left out.
	resolve(path: readonly PathElement[], without = ""): Declarations {
		let key = without + "\x01" + path.map(e => e.join(" ")).join("\x00")
		let found = this.cache.get(key)
		if (found) return found
		let leaf = path[path.length - 1], hits: Rule[] = []
		let collect = (bucket: Rule[] | undefined) => {
			if (bucket) for (let rule of bucket) {
				if (without && rule.parts[0].includes(without)) continue
				if (matches(rule, path, rule.parts.length - 1, path.length - 1)) hits.push(rule)
			}
		}
		collect(this.byClass.get(""))
		for (let token of leaf) if (token[0] != "<") collect(this.byClass.get(token))
		let result = empty
		if (hits.length) {
			hits.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
			let out: {[prop: string]: string} = {}
			for (let rule of hits) Object.assign(out, rule.decls)
			for (let rule of hits) if (rule.important) Object.assign(out, rule.important)
			result = out
		}
		if (this.cache.size > 2000) this.cache.clear()
		this.cache.set(key, result)
		return result
	}

	/// A property's value on the last element of `path` or the nearest
	/// ancestor that sets it (for inherited properties: `color`, fonts,
	/// custom properties).
	inherited(path: readonly PathElement[], prop: string, without = ""): string | null {
		for (let end = path.length; end > 0; end--) {
			let value = this.resolve(end == path.length ? path : path.slice(0, end), without)[prop]
			if (value != null && value != "inherit" && value != "unset") return value
		}
		return null
	}

	/// Substitute `var()` references in a value: custom properties set
	/// by the rules themselves (inherited along `path`), then `env`
	/// (the real element's, for ones set by the page), then the
	/// reference's fallback. Null when one can't be resolved.
	value(value: string | null | undefined, path: readonly PathElement[], env?: (name: string) => string | null, depth = 0): string | null {
		if (value == null) return null
		let at = value.indexOf("var(")
		if (at < 0) return value
		if (depth > 8) return null
		let level = 1, end = at + 4
		for (; end < value.length && level; end++) {
			if (value[end] == "(") level++
			else if (value[end] == ")") level--
		}
		if (level) return null
		let args = splitTop(value.slice(at + 4, end - 1), ","), name = args[0].trim()
		let fallback = args.length > 1 ? args.slice(1).join(",").trim() : null
		let found = this.inherited(path, name) ?? env?.(name) ?? null
		let sub = this.value(found && found.trim() ? found.trim() : fallback, path, env, depth + 1)
		if (sub == null) return null
		return this.value(value.slice(0, at) + sub + value.slice(end), path, env, depth + 1)
	}
}

/// `box-shadow: 0 0 0 2px inset red` (no offset or blur, a spread):
/// a frame inside the box. The color and width, or null.
export function insetFrame(shadow: string | null | undefined): {color: string, width: number} | null {
	if (!shadow || shadow == "none") return null
	for (let layer of splitTop(shadow, ",")) {
		let lengths: number[] = [], color = "", inset = false
		for (let w of words(layer)) {
			let px = lengthRe.test(w) ? cssLength(w) : null
			if (px != null) lengths.push(px)
			else if (w == "inset") inset = true
			else color = w
		}
		if (inset && color && lengths.length == 4 && !lengths[0] && !lengths[1] && !lengths[2] && lengths[3] > 0)
			return {color, width: lengths[3]}
	}
	return null
}
