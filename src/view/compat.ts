// Hosting CodeMirror view extensions on a CanvasView.
//
// CodeMirror's view-level packages (tooltips, panels, hover,
// autocomplete's popup, lint, the search panel, LSP client UI) are
// ViewPlugins that talk to an `EditorView`. CanvasView implements the
// parts of that interface they use (geometry from arithmetic, a real
// `dom`/`scrollDOM`/`contentDOM`), and this module runs the plugins:
// creation, `update(ViewUpdate)`, `view.plugin()`, event observers and
// handlers, `requestMeasure`, update listeners, theme classes and
// style mounting. Plugins that draw the text DOM (drawSelection,
// gutters, active line, special chars...) are skipped: the canvas
// draws those itself.

import {type Extension, Facet, type EditorState, StateEffect, type Transaction} from "@codemirror/state"
import {
	drawSelection, dropCursor, EditorView, gutters, highlightActiveLine, highlightActiveLineGutter,
	highlightSpecialChars, highlightTrailingWhitespace, highlightWhitespace, lineNumbers, placeholder,
	scrollPastEnd, ViewPlugin, ViewUpdate
} from "@codemirror/view"
import {foldGutter, HighlightStyle, language, syntaxHighlighting} from "@codemirror/language"
import {StyleModule} from "style-mod"

/// Elements of canvas views (their `dom`, `scrollDOM`, `contentDOM`
/// and widget DOM) → the view, for `findFromDOM`.
export const domViews = new WeakMap<Node, unknown>()

/// The internal facet ViewPlugins are registered through (read from a
/// plugin's own extension, since it isn't exported).
export const viewPluginFacet: Facet<{plugin: ViewPlugin<any, any>, arg: any}, readonly {plugin: ViewPlugin<any, any>, arg: any}[]> = (() => {
	let found = findProvider(ViewPlugin.define(() => ({})).extension, p => p.value && "plugin" in p.value)
	if (!found) throw new Error("canvas-view: can't find CodeMirror's viewPlugin facet")
	return found.facet
})()

/// The internal theme-class facet (from `EditorView.theme`).
const themeFacet: Facet<string, string> | null = (() => {
	let found = findProvider(EditorView.theme({}), p => typeof p.value == "string")
	return found ? found.facet : null
})()

/// CodeMirror's generated base theme class names ("ͼ1", "ͼ2", "ͼ3"),
/// recovered from a probe base theme's rules.
const baseClasses = (() => {
	let ids = {base: "", light: "", dark: ""}
	let found = findProvider(EditorView.baseTheme({"&": {"--cv": "base"}, "&light": {"--cv": "light"}, "&dark": {"--cv": "dark"}}),
		p => p.value instanceof StyleModule)
	let rules: string[] = (found?.value as any)?.rules ?? []
	for (let rule of rules) {
		let m = /^\.([^\s{.,]+)\s*\{\s*--cv:\s*(\w+)/.exec(rule)
		if (m) ids[m[2] as keyof typeof ids] = m[1]
	}
	return ids
})()

export function findProvider(ext: unknown, test: (p: any) => boolean): any {
	let seen = new Set<unknown>()
	let walk = (e: any): any => {
		if (!e || typeof e != "object" || seen.has(e)) return null
		seen.add(e)
		if (Array.isArray(e)) {
			for (let x of e) { let r = walk(x); if (r) return r }
			return null
		}
		if (e.facet && "value" in e && test(e)) return e
		if (e.inner) return walk(e.inner)
		if (e.extension) return walk(e.extension)
		return null
	}
	return walk(ext)
}

/// ViewPlugins that draw into CodeMirror's text DOM; the canvas view
/// provides these features itself.
const replacedPlugins: Set<ViewPlugin<any, any>> = (() => {
	let out = new Set<ViewPlugin<any, any>>()
	let collect = (e: any, seen = new Set<unknown>()) => {
		if (!e || typeof e != "object" || seen.has(e)) return
		seen.add(e)
		if (e instanceof ViewPlugin) { out.add(e); collect((e as any).baseExtensions, seen); return }
		if (Array.isArray(e)) { for (let x of e) collect(x, seen); return }
		if (e.facet == viewPluginFacet && e.value?.plugin) out.add(e.value.plugin)
		if (e.inner) collect(e.inner, seen)
		if (e.extension) collect(e.extension, seen)
	}
	let sources: (() => Extension)[] = [drawSelection, highlightActiveLine, highlightActiveLineGutter, lineNumbers, gutters,
		highlightSpecialChars, dropCursor, scrollPastEnd, highlightWhitespace,
		highlightTrailingWhitespace, () => placeholder("x"), foldGutter]
	for (let source of sources) {
		try { collect(source()) } catch {}
	}
	// Syntax highlighting decorations (the canvas highlights itself) and
	// CodeMirror's background parse worker, whose slices (25-100ms) would
	// drop frames during flings.
	try { collect(syntaxHighlighting(HighlightStyle.define([]))) } catch {}
	try { collect((language as any).extensions) } catch {}
	return out
})()

export function isReplacedPlugin(plugin: ViewPlugin<any, any>) { return replacedPlugins.has(plugin) }

function pluginsOf(ext: () => Extension) {
	let out = new Set<ViewPlugin<any, any>>()
	let walk = (e: any, seen = new Set<unknown>()) => {
		if (!e || typeof e != "object" || seen.has(e)) return
		seen.add(e)
		if (e instanceof ViewPlugin) { out.add(e); return }
		if (Array.isArray(e)) { for (let x of e) walk(x, seen); return }
		if (e.facet == viewPluginFacet && e.value?.plugin) out.add(e.value.plugin)
		if (e.inner) walk(e.inner, seen)
		if (e.extension) walk(e.extension, seen)
	}
	try { walk(ext()) } catch {}
	return out
}

/// CodeMirror plugins whose feature the canvas draws natively; their
/// presence in the state turns the native feature on.
export const nativeEquivalents = {
	whitespace: pluginsOf(highlightWhitespace),
	trailingWhitespace: pluginsOf(highlightTrailingWhitespace)
}

/// Base styles for the parts of CodeMirror's UI that live in its
/// (unexported) core theme: panels, dialogs, buttons and text fields.
export const canvasBaseTheme = EditorView.baseTheme({
	"&": {position: "relative", display: "flex", flexDirection: "column", boxSizing: "border-box"},
	// CodeMirror's base theme gives the scroller this line height, so a
	// line height set on "&" (the editor) doesn't reach the lines there.
	// Rows follow it unless the font config sets one (see CanvasView).
	".cm-scroller": {flex: "1 1 0", minHeight: "0", position: "relative", overflow: "hidden", contain: "strict",
		lineHeight: 1.4},
	".cm-panels": {boxSizing: "border-box", position: "relative", left: 0, right: 0, zIndex: 300},
	"&light .cm-panels": {backgroundColor: "#f5f5f5", color: "black"},
	"&light .cm-panels-top": {borderBottom: "1px solid #ddd"},
	"&light .cm-panels-bottom": {borderTop: "1px solid #ddd"},
	"&dark .cm-panels": {backgroundColor: "#333338", color: "white"},
	".cm-dialog": {padding: "2px 19px 4px 6px", position: "relative", "& label": {fontSize: "80%"}},
	".cm-dialog-close": {position: "absolute", top: "3px", right: "4px", backgroundColor: "inherit", border: "none",
		font: "inherit", fontSize: "14px", padding: "0"},
	".cm-button": {verticalAlign: "middle", color: "inherit", fontSize: "70%", padding: ".2em 1em", borderRadius: "1px"},
	"&light .cm-button": {backgroundImage: "linear-gradient(#eff1f5, #d9d9df)", border: "1px solid #888",
		"&:active": {backgroundImage: "linear-gradient(#b4b4b4, #d0d3d6)"}},
	"&dark .cm-button": {backgroundImage: "linear-gradient(#393939, #111)", border: "1px solid #888",
		"&:active": {backgroundImage: "linear-gradient(#111, #333)"}},
	".cm-textfield": {verticalAlign: "middle", color: "inherit", fontSize: "70%", border: "1px solid silver", padding: ".2em .5em"},
	"&light .cm-textfield": {backgroundColor: "white"},
	"&dark .cm-textfield": {border: "1px solid #555", backgroundColor: "inherit"}
})

const canvasBaseModule: StyleModule = findProvider(canvasBaseTheme, p => p.value instanceof StyleModule).value

export interface MeasureRequest<T> {
	read(view: any): T
	write?(measure: T, view: any): void
	key?: any
}

interface Instance {
	spec: {plugin: ViewPlugin<any, any>, arg: any} | null
	value: any
	mustUpdate: ViewUpdate | null
}

/// What the host needs from the view (it is the `EditorView` plugins see).
export interface CompatView {
	state: EditorState
	readonly dom: HTMLElement
	requestFrame(): void
}

/// Runs CodeMirror ViewPlugins against a CanvasView.
export class PluginHost {
	private instances: Instance[] = []
	private specs: readonly {plugin: ViewPlugin<any, any>, arg: any}[] = []
	private measures: MeasureRequest<any>[] = []
	private mountedModules: readonly StyleModule[] | null = null
	private classes = ""
	private attrs: {[name: string]: string} = {}
	private updating = false
	/// Bumped when the set of plugins changes.
	specsVersion = 0

	constructor(private view: CompatView) {}

	get isUpdating() { return this.updating }

	/// Whether any of these plugins is configured in the state.
	uses(plugins: Set<ViewPlugin<any, any>>) {
		return this.specs.some(s => plugins.has(s.plugin))
	}

	/// Create plugins for the current state.
	init() {
		this.mountStyles()
		this.syncPlugins()
		this.syncEditorAttrs()
	}

	private syncPlugins() {
		let specs = this.view.state.facet(viewPluginFacet)
		if (specs === this.specs) return
		let old = this.instances, next: Instance[] = []
		for (let spec of specs) {
			let known = old.find(i => i.spec && i.spec.plugin == spec.plugin && i.spec.arg == spec.arg)
			if (known) next.push(known)
			else next.push({spec: replacedPlugins.has(spec.plugin) ? null : spec, value: null, mustUpdate: null})
		}
		for (let inst of old) if (next.indexOf(inst) < 0) this.destroyInstance(inst)
		this.specs = specs
		this.specsVersion++
		this.instances = next
		for (let inst of next) this.ensure(inst)
	}

	private ensure(inst: Instance) {
		if (inst.value || !inst.spec) return inst
		try {
			inst.value = (inst.spec.plugin as any).create(this.view, inst.spec.arg)
		} catch (e) {
			this.log(e, "CodeMirror plugin crashed")
			inst.spec = inst.value = null
		}
		return inst
	}

	private runUpdate(inst: Instance) {
		let update = inst.mustUpdate
		inst.mustUpdate = null
		if (!update || !inst.value?.update) return
		try {
			inst.value.update(update)
		} catch (e) {
			this.log(e, "CodeMirror plugin crashed")
			try { inst.value.destroy?.() } catch {}
			inst.spec = inst.value = null
		}
	}

	private destroyInstance(inst: Instance) {
		try { inst.value?.destroy?.() } catch (e) { this.log(e, "CodeMirror plugin crashed") }
	}

	private log(e: unknown, context: string) {
		let sink = this.view.state.facet(EditorView.exceptionSink)
		if (sink.length) sink[0](e)
		else console.error(context + ":", e)
	}

	/// A ViewUpdate for transactions (call before the view's state is
	/// replaced, like CodeMirror does). `flags`: 1 focus, 2 height,
	/// 4 viewport, 8 viewport moved, 16 geometry.
	makeUpdate(state: EditorState, trs: readonly Transaction[], flags = 0): ViewUpdate {
		let update = (ViewUpdate as any).create(this.view, state, trs) as ViewUpdate
		;(update as any).flags |= flags
		return update
	}

	/// Run plugin updates, reconfiguration and update listeners.
	update(update: ViewUpdate) {
		this.updating = true
		try {
			let reconfigured = update.transactions.some(tr => tr.reconfigured)
			if (reconfigured) {
				this.mountStyles()
				this.syncPlugins()
			}
			for (let inst of this.instances) inst.mustUpdate = update
			for (let inst of this.instances) this.runUpdate(inst)
			this.syncEditorAttrs()
		} finally {
			this.updating = false
		}
		for (let listener of this.view.state.facet(EditorView.updateListener)) {
			try { listener(update) } catch (e) { this.log(e, "update listener") }
		}
	}

	/// `view.plugin(plugin)`: the instance, brought up to date first.
	get(plugin: ViewPlugin<any, any>) {
		for (let inst of this.instances) {
			if (inst.spec?.plugin != plugin) continue
			this.ensure(inst)
			if (inst.mustUpdate) this.runUpdate(inst)
			return inst.value
		}
		return null
	}

	/// Notify `eventObservers` (e.g. scroll); they never stop anything.
	observe(type: string, event: Event) {
		for (let inst of this.instances) {
			let obs = (inst.spec?.plugin as any)?.domEventObservers?.[type]
			if (obs && inst.value) {
				try { obs.call(inst.value, event, this.view) } catch (e) { this.log(e, "event observer") }
			}
		}
	}

	/// Run `eventObservers`, then `eventHandlers`, for an event (like
	/// CodeMirror); true when a handler handled it.
	handle(type: string, event: Event) {
		this.observe(type, event)
		for (let inst of this.instances) {
			let handler = (inst.spec?.plugin as any)?.domEventHandlers?.[type]
			if (handler && inst.value) {
				try {
					if (handler.call(inst.value, event, this.view) || event.defaultPrevented) return true
				} catch (e) { this.log(e, "event handler") }
			}
		}
		return false
	}

	requestMeasure<T>(req?: MeasureRequest<T>) {
		if (req) {
			if (req.key != null) {
				let i = this.measures.findIndex(m => m.key === req.key)
				if (i > -1) { this.measures[i] = req; this.view.requestFrame(); return }
			}
			this.measures.push(req)
		}
		this.view.requestFrame()
	}

	get hasMeasures() { return this.measures.length > 0 }

	/// Run pending measure requests: all reads, then all writes.
	runMeasures() {
		if (!this.measures.length) return
		let reqs = this.measures
		this.measures = []
		let results = reqs.map(r => {
			try { return r.read(this.view) } catch (e) { this.log(e, "measure"); return null }
		})
		reqs.forEach((r, i) => {
			if (r.write) try { r.write(results[i], this.view) } catch (e) { this.log(e, "measure") }
		})
	}

	/// CodeMirror's theme classes for the editor element.
	get themeClasses() {
		let state = this.view.state
		return baseClasses.base + " " + (state.facet(EditorView.darkTheme) ? baseClasses.dark : baseClasses.light) +
			(themeFacet ? " " + state.facet(themeFacet) : "")
	}

	private mountStyles() {
		let modules = this.view.state.facet(EditorView.styleModule)
		if (modules === this.mountedModules) return
		this.mountedModules = modules
		let nonce = this.view.state.facet(EditorView.cspNonce)
		StyleModule.mount(this.view.dom.ownerDocument, (modules as StyleModule[]).concat(canvasBaseModule).reverse(), nonce ? {nonce} : undefined)
	}

	/// Apply `EditorView.editorAttributes` and the theme classes to `dom`.
	private syncEditorAttrs() {
		let dom = this.view.dom
		let cls = "cm-editor " + this.themeClasses, attrs: {[name: string]: string} = {}
		for (let source of this.view.state.facet(EditorView.editorAttributes)) {
			let value = typeof source == "function" ? (source as any)(this.view) : source
			if (!value) continue
			for (let name in value) {
				if (name == "class") cls += " " + value[name]
				else attrs[name] = value[name]
			}
		}
		if (cls != this.classes) {
			for (let c of this.classes.split(" ")) if (c && !cls.split(" ").includes(c)) dom.classList.remove(c)
			for (let c of cls.split(" ")) if (c) dom.classList.add(c)
			this.classes = cls
		}
		for (let name in this.attrs) if (!(name in attrs)) dom.removeAttribute(name)
		for (let name in attrs) if (this.attrs[name] != attrs[name]) dom.setAttribute(name, attrs[name])
		this.attrs = attrs
	}

	/// Effects from `EditorView.focusChangeEffect` for a focus change.
	focusEffects(focused: boolean) {
		let state = this.view.state, effects: StateEffect<any>[] = []
		for (let f of state.facet(EditorView.focusChangeEffect)) {
			let e = f(state, focused)
			if (e) effects.push(e)
		}
		return effects
	}

	destroy() {
		for (let inst of this.instances) this.destroyInstance(inst)
		this.instances = []
	}
}

/// Whether `EditorView.lineWrapping` (or another `cm-lineWrapping`
/// content class) is configured.
export function wantsLineWrapping(state: EditorState, view: unknown) {
	for (let source of state.facet(EditorView.contentAttributes)) {
		let value = typeof source == "function" ? (source as any)(view) : source
		if (value && typeof value.class == "string" && /(^|\s)cm-lineWrapping(\s|$)/.test(value.class)) return true
	}
	return false
}
