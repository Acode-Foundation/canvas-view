import type {Text} from "@codemirror/state"
import type {Input} from "@lezer/common"
import type {EncodedTree} from "./treecodec"

// Messages between the main thread's syntax worker client
// (view/syntaxworker.ts) and the worker runtime (worker.ts).

/// Bumped on any change to the messages or tree records.
export const SYNTAX_PROTOCOL = 1

export type ToWorker =
	| {t: "hello", protocol: number}
	/// `seed`: a tree already parsed for `text` (up to `seedLen`).
	| {t: "open", id: number, lang: string, fp: string, text: string, version: number, visible: number,
	   seed: EncodedTree | null, seedLen: number}
	/// `changes`: a ChangeSet's JSON, from the previous version.
	| {t: "edit", id: number, version: number, changes: unknown}
	| {t: "visible", id: number, to: number}
	| {t: "close", id: number}

export type FromWorker =
	| {t: "hello", protocol: number}
	/// The document's tree for `version`, parsed up to `len`.
	| {t: "tree", id: number, version: number, len: number, tree: EncodedTree}
	/// Still working (sent while parsing takes long).
	| {t: "busy"}
	| {t: "unsupported", id: number, reason: string}
	/// With an id, that document failed; without, the worker did.
	| {t: "error", id?: number, message: string}

/// A parse input reading a CodeMirror `Text` (like @codemirror/language's
/// DocInput, which the worker doesn't load: that package loads the view).
export class TextInput implements Input {
	private cursorPos = 0
	private string = ""
	private cursor: ReturnType<Text["iter"]>

	constructor(readonly doc: Text) {
		this.cursor = doc.iter()
	}

	get length() { return this.doc.length }

	get lineChunks() { return true }

	private syncTo(pos: number) {
		this.string = this.cursor.next(pos - this.cursorPos).value
		this.cursorPos = pos + this.string.length
		return this.cursorPos - this.string.length
	}

	chunk(pos: number) {
		this.syncTo(pos)
		return this.string
	}

	read(from: number, to: number) {
		let start = this.cursorPos - this.string.length
		if (from < start || to >= this.cursorPos) return this.doc.sliceString(from, to)
		return this.string.slice(from - start, to - start)
	}
}
