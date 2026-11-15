import {expect, test} from "bun:test"
import {EditorState} from "@codemirror/state"
import {oneDark, oneDarkHighlightStyle} from "@codemirror/theme-one-dark"
import {EditorView} from "@codemirror/view"
import {tags} from "@lezer/highlight"
import {themeClassesOf} from "../src/view/compat"
import {cssLength, insetFrame, splitTop, StyleSheetModel} from "../src/view/cssresolve"
import {ThemeCSS} from "../src/view/csstheme"

const line = (editor: string[]) => [editor, ["cm-scroller"], ["cm-content"], ["cm-line"]]

function cssOf(extensions: any, extra?: string, env: (name: string) => string | null | undefined = () => null) {
	let state = EditorState.create({extensions})
	let modules = (state.facet(EditorView.styleModule) as any[]).slice().reverse()
	return {state, css: new ThemeCSS(StyleSheetModel.of(modules, extra ? [extra] : []), themeClassesOf(state), env)}
}

test("specificity, order and selector lists", () => {
	let m = new StyleSheetModel([`
		.a { color: red; font-weight: bold }
		.e .a { color: green }
		.a, .b { background-color: #111 }
		.a { color: blue; }
	`])
	expect(m.resolve([["e"], ["a"]]).color).toBe("green")
	expect(m.resolve([["x"], ["a"]]).color).toBe("blue")
	expect(m.resolve([["x"], ["a"]])["font-weight"]).toBe("bold")
	expect(m.resolve([["b"]])["background-color"]).toBe("#111")
	expect(m.resolve([["c"]])).toEqual({})
})

test("later sources win at equal specificity", () => {
	let m = new StyleSheetModel([".a { color: red }", ".a { color: blue }"])
	expect(m.resolve([["a"]]).color).toBe("blue")
})

test("child and descendant combinators", () => {
	let m = new StyleSheetModel([`
		.e > .s > .layer .sel { color: red }
		.e > .sel { color: blue }
		.e .s .x > .sel { color: green }
	`])
	expect(m.resolve([["e"], ["s"], ["layer"], ["sel"]]).color).toBe("red")
	expect(m.resolve([["e"], ["s"], ["layer"], ["mid"], ["sel"]]).color).toBe("red")
	expect(m.resolve([["e"], ["mid"], ["s"], ["layer"], ["sel"]]).color).toBeUndefined()
	expect(m.resolve([["e"], ["sel"]]).color).toBe("blue")
	// The descendant step backtracks: the nearest `.s` isn't under `.e`'s child.
	expect(m.resolve([["e"], ["s"], ["q"], ["s"], ["x"], ["sel"]]).color).toBe("green")
})

test("tags, universal selectors and compound classes", () => {
	let m = new StyleSheetModel(["span.t { color: red } .l * { font-style: italic } .t.u { color: blue } div.t { color: green }"])
	expect(m.resolve([["l"], ["<span", "t"]])).toEqual({color: "red", "font-style": "italic"})
	expect(m.resolve([["l"], ["<span", "t", "u"]]).color).toBe("blue")
	expect(m.resolve([["t"]]).color).toBeUndefined()
})

test("!important beats specificity", () => {
	let m = new StyleSheetModel([".a { color: red !important } .e .a { color: green }"])
	expect(m.resolve([["e"], ["a"]]).color).toBe("red")
})

test("unsupported rules are skipped but their classes are known", () => {
	let m = new StyleSheetModel([`
		.a:hover { color: red }
		.a::selection, .b { color: green }
		.c[aria-selected] { color: red }
		.d + .e { color: red }
		#id .f { color: red }
		@media (prefers-color-scheme: dark) { .g { color: red } }
		@keyframes blink { 0% {} 50% { opacity: 0 } }
		.h { color: blue }
	`])
	for (let cls of ["a", "c", "e", "f", "g"]) {
		expect(m.resolve([[cls]])).toEqual({})
		expect(m.defines(cls)).toBe(true)
	}
	expect(m.resolve([["b"]]).color).toBe("green")
	expect(m.resolve([["h"]]).color).toBe("blue")
	expect(m.defines("zzz")).toBe(false)
})

test("shorthands cascade with their longhands", () => {
	let m = new StyleSheetModel([`
		.a { background-color: red; background: #abc url("x;y.png") no-repeat }
		.b { background: linear-gradient(red, blue) }
		.c { background: none; background-color: rgb(1, 2, 3) }
		.d { border: 1px solid #ddd; border-left: 3px dashed rgba(0, 0, 0, .5) }
		.e { text-decoration: underline wavy #f00 }
		.f { border-color: red blue; outline: 2px solid green }
	`])
	expect(m.resolve([["a"]])["background-color"]).toBe("#abc")
	expect(m.resolve([["b"]])["background-color"]).toBe("transparent")
	expect(m.resolve([["c"]])["background-color"]).toBe("rgb(1, 2, 3)")
	let d = m.resolve([["d"]])
	expect([d["border-top-color"], d["border-left-color"], d["border-left-style"], d["border-left-width"]])
		.toEqual(["#ddd", "rgba(0, 0, 0, .5)", "dashed", "3px"])
	let e = m.resolve([["e"]])
	expect([e["text-decoration-line"], e["text-decoration-style"], e["text-decoration-color"]]).toEqual(["underline", "wavy", "#f00"])
	let f = m.resolve([["f"]])
	expect([f["border-top-color"], f["border-right-color"], f["border-bottom-color"], f["outline-color"]]).toEqual(["red", "blue", "red", "green"])
})

test("custom properties: inherited, environment, fallbacks", () => {
	let m = new StyleSheetModel([`
		.e { --accent: #123; --ref: var(--accent) }
		.a { color: var(--accent); background-color: var(--page, #fff); border-top-color: var(--ref); outline-color: var(--none) }
		.b { color: rgba(var(--rgb), 0.5) }
	`])
	let path = [["e"], ["a"]], d = m.resolve(path)
	expect(m.value(d.color, path)).toBe("#123")
	expect(m.value(d["background-color"], path)).toBe("#fff")
	expect(m.value(d["background-color"], path, n => n == "--page" ? "teal" : null)).toBe("teal")
	expect(m.value(d["border-top-color"], path)).toBe("#123")
	expect(m.value(d["outline-color"], path)).toBeNull()
	expect(m.value(m.resolve([["b"]]).color, [["b"]], () => "1, 2, 3")).toBe("rgba(1, 2, 3, 0.5)")
})

test("helpers", () => {
	expect(splitTop("a, rgb(1, 2, 3), 'x,y'", ",").map(s => s.trim())).toEqual(["a", "rgb(1, 2, 3)", "'x,y'"])
	expect(insetFrame("0 0 0 2px inset #f00")).toEqual({color: "#f00", width: 2})
	expect(insetFrame("inset 0 0 0 1px rgba(0, 0, 0, 0.3)")).toEqual({color: "rgba(0, 0, 0, 0.3)", width: 1})
	expect(insetFrame("0 2px 4px #000")).toBeNull()
	expect(cssLength("1.5px")).toBe(1.5)
	expect(cssLength("0")).toBe(0)
	expect(cssLength("2em", 10)).toBe(20)
})

test("models are shared per module array, modules parsed once", () => {
	let {state} = cssOf([oneDark])
	let modules = state.facet(EditorView.styleModule) as any[]
	expect(StyleSheetModel.of(modules)).toBe(StyleSheetModel.of(modules))
	expect(StyleSheetModel.of(modules, ["a {}"])).not.toBe(StyleSheetModel.of(modules))
	let calls = 0, mod = {getRules() { calls++; return ".a { color: red }" }}
	new StyleSheetModel([mod])
	new StyleSheetModel([mod, ".b {}"])
	expect(calls).toBe(1)
})

test("One Dark: theme colors from its style modules", () => {
	let {css} = cssOf([oneDark])
	expect(css.themeSpec()).toMatchObject({
		background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selection: "#3E4451",
		activeLine: "#6699ff0b", gutterBackground: "#282c34", gutterForeground: "#7d8799", activeLineGutter: "#2c313a"
	})
	// `border: none` on the gutters: no border color.
	expect(css.themeSpec().gutterBorder).toBeUndefined()
	expect(css.pending).toBe(false)
})

test("One Dark: highlight classes", () => {
	let {css} = cssOf([oneDark])
	let cls = (tag: any) => oneDarkHighlightStyle.style([tag])!
	expect(css.token(cls(tags.keyword))).toMatchObject({color: 0xffdd78c6, bold: false, italic: false})
	expect(css.token(cls(tags.strong))).toMatchObject({color: null, bold: true})
	expect(css.token(cls(tags.emphasis))).toMatchObject({italic: true})
	expect(css.token(cls(tags.strikethrough))).toMatchObject({strike: true})
	expect(css.token(cls(tags.link))!.underline).toBe(true)
	// Classes from a page stylesheet aren't in the modules.
	expect(css.token("tok-keyword")).toBeUndefined()
	expect(css.token(cls(tags.keyword) + " tok-keyword")).toBeUndefined()
})

test("a theme over another: precedence follows the facet", () => {
	let {css} = cssOf([EditorView.theme({"&": {backgroundColor: "#010203"}, ".cm-gutters": {borderRight: "2px solid #456"}}), oneDark])
	let spec = css.themeSpec()
	expect(spec.background).toBe("#010203")
	expect(spec.gutterBorder).toBe("#456")
	expect(spec.foreground).toBe("#abb2bf")
})

test("active line frames, focused selection, custom properties", () => {
	let theme = EditorView.theme({
		"&": {color: "var(--fg)", backgroundColor: "var(--bg, #101010)"},
		".cm-activeLine": {boxShadow: "0 0 0 2px inset #f00"},
		".cm-selectionBackground": {background: "#111"},
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {background: "#222"},
		".cm-content": {caretColor: "#0f0"},
		".cm-activeLineGutter": {color: "#fff"}
	})
	let {css} = cssOf([theme], undefined, n => n == "--fg" ? "#eee" : null)
	expect(css.themeSpec()).toMatchObject({
		background: "#101010", foreground: "#eee", activeLine: "transparent", activeLineBorder: "#f00", activeLineBorderWidth: 2,
		selection: "#222", cursor: "#0f0", gutterActiveForeground: "#fff"
	})
	// Not in the document yet: unresolved, and flagged for another try.
	let later = cssOf([theme], undefined, () => undefined).css
	expect(later.themeSpec().foreground).toBeUndefined()
	expect(later.pending).toBe(true)
})

test("decoration classes: themes, base themes, extra CSS", () => {
	let base = EditorView.baseTheme({
		".cm-searchMatch": {backgroundColor: "#ffff0054"},
		".cm-myMark": {color: "#f00", textDecoration: "underline wavy #00f", fontWeight: "bold", border: "1px solid #333"}
	})
	let {css, state} = cssOf([base, EditorView.theme({".cm-selectionMatch": {backgroundColor: "#0f04"}})],
		".cm-editor .cm-pageMark { background: #abc; font-style: italic }")
	let baseId = themeClassesOf(state).split(" ")[0]
	expect(css.mark("cm-myMark", "")).toEqual({color: "#f00", underline: "wavy", underlineColor: "#00f", bold: true, border: "#333"})
	expect(css.mark("cm-searchMatch", "")).toEqual({background: "#ffff0054"})
	// Built-in classes ignore base themes, but not themes.
	expect(css.mark("cm-searchMatch", baseId)).toBeNull()
	expect(css.mark("cm-selectionMatch", baseId)).toEqual({background: "#0f04"})
	expect(css.mark("cm-pageMark")).toEqual({background: "#abc", italic: true})
	// Classes together, under a focused editor; `none` takes a default's away.
	let acode = cssOf([EditorView.theme({
		".cm-searchMatch.cm-searchMatch-selected": {backgroundColor: "#123"},
		"&.cm-focused .cm-matchingBracket": {backgroundColor: "#456", outline: "none"},
		".cm-foldPlaceholder": {backgroundColor: "transparent", border: "none", color: "#eee"},
		".cm-lineNumbers .cm-gutterElement": {color: "#777"},
		".cm-lineNumbers .cm-activeLineGutter": {color: "#fff"},
		".cm-gutters": {color: "#ccc"}
	})]).css
	expect(acode.mark("cm-searchMatch cm-searchMatch-selected")).toEqual({background: "#123"})
	expect(acode.mark("cm-searchMatch")).toBeNull()
	expect(acode.mark("cm-matchingBracket")).toEqual({background: "#456", border: "transparent"})
	expect(acode.mark("cm-foldPlaceholder")).toEqual({background: "transparent", border: "transparent", color: "#eee"})
	expect(acode.themeSpec()).toMatchObject({gutterForeground: "#777", gutterActiveForeground: "#fff"})
	expect(css.mark("cm-unknown")).toBeNull()
})

test("gutter element classes", () => {
	let {css} = cssOf([EditorView.theme({
		".cm-breakpoint-gutter .cm-hit": {backgroundColor: "#f005"},
		".cm-lineNumbers .cm-gutterElement.cm-changed": {backgroundColor: "#0f0"}
	})])
	expect(css.gutterElement("cm-breakpoint-gutter", "cm-hit")).toBe(0x550000ff)
	expect(css.gutterElement("cm-lineNumbers", "cm-hit")).toBeNull()
	expect(css.gutterElement("cm-lineNumbers", "cm-changed")).toBe(0xff00ff00)
	expect(css.gutterElement("", "cm-fromThePage")).toBeUndefined()
})

test("a path is resolved once", () => {
	let m = new StyleSheetModel([".a { color: red }"]), path = line(["e"]).concat([["a"]])
	expect(m.resolve(path)).toBe(m.resolve(path.map(p => p.slice())))
})
