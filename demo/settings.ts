// A side panel for trying every configuration option. Settings live in
// the URL (so a configuration can be shared as a link); options that can
// change live are applied through `view.reconfigure` / `setFont`, the
// others reload the page.
import {Compartment, EditorState} from "@codemirror/state"
import type {CanvasView} from "../src/index"
import firaCodeUrl from "./fonts/FiraCode.ttf?url"

/// Read-only is state-level: toggled through this compartment.
export const readOnlyCompartment = new Compartment()

type Choice = [value: string, label: string]

interface Setting {
	key: string
	label: string
	choices: Choice[]
	def: string
	/// Apply without reloading.
	live?: (view: CanvasView, value: string) => void
}

interface Section {
	title: string
	settings: Setting[]
}

const onOff: Choice[] = [["1", "On"], ["0", "Off"]]

/// The demo's fonts: the default monospace stack, or Fira Code (the
/// ligature font Acode ships), loaded when first chosen.
export const systemFonts = "ui-monospace, 'Roboto Mono', 'Droid Sans Mono', Menlo, Consolas, monospace"
let firaCode: FontFace | null = null
export function fontFamily(name: string) {
	if (name != "fira") return systemFonts
	if (!firaCode) {
		firaCode = new FontFace("Fira Code", `url(${firaCodeUrl})`)
		document.fonts.add(firaCode)
		firaCode.load()
	}
	return "'Fira Code', monospace"
}

export function ligatureOption(value: string) {
	return value == "auto" ? undefined : value == "1"
}

export const sections: Section[] = [
	{title: "Document", settings: [
		{key: "kind", label: "Content", def: "js", choices: [["js", "JavaScript"], ["html", "HTML"], ["unicode", "Unicode"], ["rtl", "Right-to-left text"], ["longline", "Long lines"], ["deep", "Deep nesting"], ["empty", "Empty (placeholder)"]]},
		{key: "lines", label: "Lines", def: "120000", choices: [["200", "200"], ["2000", "2,000"], ["20000", "20,000"], ["120000", "120,000"], ["1000000", "1,000,000"]]},
		{key: "tabSize", label: "Tab size", def: "4", choices: [["2", "2"], ["4", "4"], ["8", "8"]]}
	]},
	{title: "Wrapping", settings: [
		{key: "wrap", label: "Line wrapping", def: "0", choices: onOff, live: (v, x) => v.reconfigure({lineWrapping: x == "1"})},
		{key: "wrapIndent", label: "Wrap indent", def: "same",
			choices: [["none", "None"], ["same", "Same as line"], ["1", "Same + 1"], ["2", "Same + 2"], ["indent", "One level more"], ["deepIndent", "Two levels more"]],
			live: (v, x) => v.reconfigure({wrapIndent: /^\d+$/.test(x) ? +x : x as any})},
		{key: "dir", label: "Text direction", def: "ltr", choices: [["ltr", "Left to right"], ["auto", "Per line (auto)"], ["rtl", "Right to left"]],
			live: (v, x) => v.reconfigure({textDirection: x as any})}
	]},
	{title: "Gutter & guides", settings: [
		{key: "lineNumbers", label: "Line numbers", def: "1", choices: [["1", "On"], ["relative", "Relative"], ["0", "Off"]],
			live: (v, x) => v.reconfigure({lineNumbers: x == "relative" ? "relative" : x == "1"})},
		{key: "markers", label: "Gutter markers", def: "shared",
			choices: [["shared", "One shared column"], ["columns", "Column per gutter"], ["overlay", "Over the line numbers (no column)"]],
			live: (v, x) => v.reconfigure({gutterMarkers: x as any})},
		{key: "breakpoints", label: "Breakpoint gutter (CodeMirror example)", def: "0", choices: onOff},
		{key: "activeLine", label: "Highlight active line", def: "1", choices: onOff, live: (v, x) => v.reconfigure({highlightActiveLine: x == "1"})},
		{key: "foldMarkers", label: "Fold markers", def: "fade", choices: [["fade", "Fade (cursor / hover)"], ["always", "Always"], ["none", "None"]],
			live: (v, x) => v.reconfigure({foldMarkers: x as any})},
		{key: "guides", label: "Indent guides", def: "active", choices: [["active", "On + active block"], ["on", "On"], ["blank", "On, not on blank lines"], ["off", "Off"]],
			live: (v, x) => v.reconfigure({indentGuides: guideOption(x)})},
		{key: "rainbow", label: "Rainbow brackets", def: "1", choices: onOff, live: (v, x) => v.reconfigure({rainbowBrackets: x == "1"})},
		{key: "sticky", label: "Sticky scroll", def: "5", choices: [["0", "Off"], ["1", "1 line"], ["3", "Up to 3 lines"], ["5", "Up to 5 lines"]],
			live: (v, x) => v.reconfigure({stickyScroll: stickyOption(x)})},
		{key: "whitespace", label: "Show whitespace", def: "0",
			choices: [["0", "Off"], ["1", "Spaces, tabs, trailing"], ["all", "Also line ends"]],
			live: (v, x) => v.reconfigure({showWhitespace: whitespaceOption(x)})}
	]},
	{title: "Scrolling", settings: [
		{key: "scrollSpeed", label: "Scroll speed", def: "normal", choices: [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["fastX2", "Fast ×2"]],
			live: (v, x) => v.reconfigure({scrollSpeed: x as any})},
		{key: "pastEnd", label: "Scroll past end", def: "1", choices: [["0", "Off"], ["0.25", "Small"], ["0.5", "Medium"], ["1", "Full"]],
			live: (v, x) => v.reconfigure({scrollPastEnd: +x})},
		{key: "hPastEnd", label: "Horizontal past end", def: "0", choices: [["0", "None (4 columns)"], ["40", "+40px"], ["100", "+100px"]],
			live: (v, x) => v.reconfigure({horizontalScrollPastEnd: +x})}
	]},
	{title: "Appearance", settings: [
		{key: "fontSize", label: "Font size", def: "14", choices: ["11", "12", "13", "14", "15", "16", "18", "20"].map(n => [n, n + "px"] as Choice),
			live: (v, x) => v.setFont({size: +x})},
		{key: "lineHeight", label: "Line height", def: "1.5", choices: [["1.3", "1.3"], ["1.5", "1.5"], ["1.7", "1.7"]],
			live: (v, x) => v.setFont({lineHeight: +x})},
		{key: "font", label: "Font", def: "system", choices: [["system", "System monospace"], ["fira", "Fira Code (ligatures)"]],
			live: (v, x) => v.setFont({family: fontFamily(x)})},
		{key: "ligatures", label: "Font ligatures (with a ligature font, e.g. Fira Code)", def: "auto", choices: [["auto", "Follow the CSS (on)"], ["1", "On"], ["0", "Off"]],
			live: (v, x) => v.reconfigure({fontLigatures: ligatureOption(x)})},
		{key: "theme", label: "Theme", def: "dark", choices: [["dark", "Dark"], ["light", "Light"]]},
		{key: "cursorWidth", label: "Cursor width", def: "2", choices: [["1", "1px"], ["2", "2px"], ["3", "3px"]],
			live: (v, x) => v.reconfigure({cursorWidth: +x})},
		{key: "blink", label: "Cursor blink", def: "1200", choices: [["0", "Off"], ["600", "Fast"], ["1200", "Normal"]],
			live: (v, x) => v.reconfigure({cursorBlinkRate: +x})}
	]},
	{title: "Editing", settings: [
		{key: "readOnly", label: "Read-only", def: "0", choices: onOff,
			live: (v, x) => v.dispatch({effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(x == "1"))})},
		{key: "ext", label: "CodeMirror plugins", def: "full", choices: [["full", "Search, autocomplete, lint, hover, inlay hints"], ["basic", "None (state only)"]]},
		{key: "input", label: "Text input", def: "auto", choices: [["auto", "Auto"], ["editcontext", "EditContext"], ["textarea", "Textarea"]]},
		{key: "handles", label: "Selection handles", def: "20", choices: [["0", "Off"], ["16", "Small"], ["20", "Normal"], ["26", "Large"]]}
	]},
	{title: "Rendering", settings: [
		{key: "backend", label: "GPU backend", def: "webgl2", choices: [["webgl2", "WebGL2"], ["webgpu", "WebGPU"]]}
	]}
]

export function whitespaceOption(x: string) {
	return x == "all" ? true : x == "1" ? {lineBreaks: false} : false
}

export function stickyOption(x: string) {
	return +x > 0 ? {maxLines: +x} : false
}

export function guideOption(x: string) {
	return x == "off" ? false : x == "on" ? {active: false} : x == "blank" ? {hideOnBlankLines: true} : true
}

/// The current value of a setting (URL param or default).
export function setting(params: URLSearchParams, key: string) {
	for (let s of sections) for (let set of s.settings) if (set.key == key) return params.get(key) ?? set.def
	return params.get(key)
}

export function mountSettings(view: CanvasView, params: URLSearchParams) {
	let panel = document.createElement("aside")
	panel.id = "settings"
	let head = document.createElement("div")
	head.className = "head"
	head.innerHTML = `<b>Settings</b>`
	let close = document.createElement("button")
	close.textContent = "✕"
	close.onclick = () => panel.classList.remove("open")
	head.appendChild(close)
	panel.appendChild(head)
	for (let section of sections) {
		let h = document.createElement("h3")
		h.textContent = section.title
		panel.appendChild(h)
		for (let s of section.settings) {
			let row = document.createElement("label")
			let name = document.createElement("span")
			name.textContent = s.label + (s.live ? "" : " ↻")
			name.title = s.live ? "Applies immediately" : "Reloads the page"
			let select = document.createElement("select")
			for (let [value, label] of s.choices) select.add(new Option(label, value))
			select.value = setting(params, s.key)!
			select.onchange = () => {
				if (select.value == s.def) params.delete(s.key)
				else params.set(s.key, select.value)
				let url = location.pathname + (params.toString() ? "?" + params : "")
				if (s.live) {
					history.replaceState(null, "", url)
					s.live(view, select.value)
				} else {
					location.href = url
				}
			}
			row.append(name, select)
			panel.appendChild(row)
		}
	}
	let note = document.createElement("p")
	note.className = "note"
	note.textContent = "↻ reloads the page. Settings are kept in the URL, so you can share a link."
	panel.appendChild(note)
	let reset = document.createElement("button")
	reset.textContent = "Reset all"
	reset.onclick = () => { location.href = location.pathname }
	panel.appendChild(reset)
	document.body.appendChild(panel)

	let toggle = document.getElementById("settings-toggle")!
	toggle.onclick = () => panel.classList.toggle("open")
	// Keep the editor's focus (and keyboard) when tapping the toggle.
	toggle.onpointerdown = e => e.preventDefault()
}
