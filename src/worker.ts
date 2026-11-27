import {ChangeSet, Text} from "@codemirror/state"
import type {NodeSet, Parser, PartialParse, Tree} from "@lezer/common"
import {TreeFragment} from "@lezer/common"
import {type FromWorker, SYNTAX_PROTOCOL, TextInput, type ToWorker} from "./core/syntaxprotocol"
import {nestedParser, parserFingerprint, setFingerprint, transferables, TreeDecoder, TreeEncoder} from "./core/treecodec"

// The worker side of `syntaxWorker`: parses documents the main thread's
// views open, and sends their trees back. Load it in a worker file:
//
//     import {serveSyntax} from "@acode.app/canvas-view/worker"
//     import {javascriptLanguage} from "@codemirror/lang-javascript"
//     serveSyntax([javascriptLanguage])

/// Languages a syntax worker parses: a list of languages (or anything
/// with a `name` and a `parser`), or a function returning the parsers for
/// a language name (it may load them, returning a promise). The main
/// thread asks by `Language.name`, and only uses the worker when one of
/// them is configured like its own parser (same node set, dialect, top
/// rule and number of `parseMixed` wrappers): the worker picks that one.
/// A name can stand for several configurations (`@codemirror/lang-javascript`'s
/// JSX dialect is named "javascript" too), so give all of those the editor
/// uses. Parsers mounted by `parseMixed` need a `nodeSet` property (LR and
/// Markdown parsers have one); a document whose trees mount one without
/// it is parsed on the main thread.
export type SyntaxLanguages =
	| readonly {readonly name: string, readonly parser: Parser}[]
	| ((name: string) => Parser | readonly Parser[] | null | undefined | Promise<Parser | readonly Parser[] | null | undefined>)

/// Where the worker gets messages and posts replies (the worker's global
/// scope by default; a `MessagePort` works too).
export interface SyntaxWorkerScope {
	postMessage(message: unknown, transfer: Transferable[]): void
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void
	start?(): void
}

/// How long a parse slice runs before the worker reads its messages.
const SLICE = 25
/// The first stage of a parse ends this far past the visible text, so
/// the screen's tree comes before the whole document's.
const STAGE_AHEAD = 30_000
const MIXED_STAGE_AHEAD = 3000
/// While parsing, the worker says so at least this often (the main
/// thread treats a long silence while it owes a tree as a hang).
const BUSY_EVERY = 400

function rangesOf(changes: ChangeSet) {
	let ranges: {fromA: number, toA: number, fromB: number, toB: number}[] = []
	changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({fromA, toA, fromB, toB}))
	return ranges
}

class WorkerDoc {
	tree: Tree | null = null
	/// The document `tree` was parsed for.
	treeDoc: Text | null = null
	treeLen = 0
	fragments: readonly TreeFragment[] = []
	parse: PartialParse | null = null
	/// Edits made since a running mixed-language parse started: it can't
	/// stop where it is (no partial trees), so it finishes on its own
	/// document and is then parsed again with these applied.
	pending: ChangeSet | null = null
	encoder = new TreeEncoder()
	mixed: boolean
	touched = 0

	constructor(readonly id: number, readonly parser: Parser, public doc: Text, public version: number, public visibleTo: number) {
		this.mixed = !!(parser as {wrappers?: readonly unknown[]}).wrappers?.length
	}

	get set() { return (this.parser as unknown as {nodeSet: NodeSet}).nodeSet }

	/// Where the running parse should stop: past the visible text while
	/// the tree there isn't well ahead of it (the screen may be moving),
	/// the document's end otherwise.
	get stage() {
		let doc = this.doc.length, ahead = this.mixed ? MIXED_STAGE_AHEAD : STAGE_AHEAD
		if (this.treeLen >= Math.min(this.visibleTo + ahead / 2, doc)) return doc
		return Math.min(doc, this.visibleTo + ahead)
	}

	get needsWork() { return !!this.parse || this.treeLen < this.doc.length }

	/// Parse until `end`. Returns a tree to send when a stage is done.
	work(end: number): Tree | null {
		let stage = this.stage
		if (!this.parse) {
			if (this.treeLen >= stage) return null
			this.parse = this.parser.startParse(new TextInput(this.doc), this.fragments)
		}
		let parse = this.parse
		// A parse of an older document keeps its own stop position.
		if (!this.pending && stage < this.doc.length && (parse.stoppedAt == null || parse.stoppedAt > stage)) parse.stopAt(stage)
		for (let steps = 1;; steps++) {
			let done = parse.advance()
			if (done && this.pending) {
				let pending = this.pending
				let len = Math.min(parse.stoppedAt ?? pending.length, pending.length)
				this.fragments = TreeFragment.applyChanges(TreeFragment.addTree(done, [], len < pending.length), rangesOf(pending))
				this.pending = null
				parse = this.parse = this.parser.startParse(new TextInput(this.doc), this.fragments)
				stage = this.stage
				if (stage < this.doc.length) parse.stopAt(stage)
				continue
			}
			if (done) {
				let len = Math.min(parse.stoppedAt ?? this.doc.length, this.doc.length)
				this.parse = null
				this.tree = done
				this.treeDoc = this.doc
				this.treeLen = len
				this.fragments = TreeFragment.addTree(done, this.fragments, len < this.doc.length)
				return done
			}
			if (steps % 8 == 0 && performance.now() > end) return null
		}
	}

	edit(changes: ChangeSet, version: number) {
		let old = this.doc
		this.doc = changes.apply(old)
		this.version = version
		let ranges = rangesOf(changes)
		if (this.parse && this.mixed) this.pending = this.pending ? this.pending.compose(changes) : changes
		else if (this.parse) this.takeTree(old)
		// Only the previous document's tree (an older one is in the
		// fragments, mapped).
		if (this.tree && this.treeDoc === old) this.fragments = TreeFragment.addTree(this.tree, this.fragments, true)
		this.fragments = TreeFragment.applyChanges(this.fragments, ranges)
		this.treeLen = Math.min(this.treeLen, ranges[0].fromA)
		if (!this.pending) this.parse = null
	}

	/// Stop a (non-mixed) parse where it is, keeping what it parsed.
	private takeTree(doc: Text) {
		let parse = this.parse!
		this.parse = null
		let pos = parse.parsedPos
		if (pos <= this.treeLen) return
		if (parse.stoppedAt == null || parse.stoppedAt > pos) parse.stopAt(pos)
		let tree: Tree | null
		while (!(tree = parse.advance())) {}
		this.tree = tree
		this.treeDoc = doc
		this.treeLen = pos
		this.fragments = TreeFragment.addTree(tree, this.fragments, true)
	}
}

/// Serve syntax parsing to the main thread's `syntaxWorker` views. Call
/// it once, in the worker file.
export function serveSyntax(languages: SyntaxLanguages, scope: SyntaxWorkerScope = globalThis as unknown as SyntaxWorkerScope) {
	let docs = new Map<number, WorkerDoc>()
	// Messages for documents still being opened (their parser may load).
	let opening = new Map<number, ToWorker[]>()
	let touch = 0, lastPost = 0, scheduled = false

	let post = (message: FromWorker, transfer: Transferable[] = []) => {
		lastPost = performance.now()
		scope.postMessage(message, transfer)
	}

	let lookup = async (name: string): Promise<readonly Parser[]> => {
		let found = typeof languages == "function" ? await languages(name) : languages.filter(l => l.name == name).map(l => l.parser)
		return !found ? [] : Array.isArray(found) ? found : [found as Parser]
	}

	let channel = new MessageChannel()
	channel.port1.onmessage = () => {
		scheduled = false
		pump()
	}
	let schedule = () => {
		if (scheduled) return
		scheduled = true
		channel.port2.postMessage(null)
	}

	let fail = (id: number, e: unknown) => {
		docs.delete(id)
		opening.delete(id)
		post({t: "error", id, message: String((e as Error)?.stack ?? e)})
	}

	let send = (d: WorkerDoc, tree: Tree) => {
		let enc = d.encoder.encode(tree, d.set, d.fragments.map(f => f.tree))
		post({t: "tree", id: d.id, version: d.version, len: d.treeLen, tree: enc}, transferables(enc))
	}

	let pump = () => {
		let end = performance.now() + SLICE
		let next: WorkerDoc | null = null
		for (let d of docs.values()) if (d.needsWork && (!next || d.touched > next.touched)) next = d
		if (!next) return
		try {
			let tree = next.work(end)
			if (tree) send(next, tree)
		} catch (e) {
			fail(next.id, e)
		}
		if (performance.now() - lastPost > BUSY_EVERY) post({t: "busy"})
		schedule()
	}

	let open = async (m: Extract<ToWorker, {t: "open"}>) => {
		let parsers = await lookup(m.lang)
		if (!opening.has(m.id)) return // Closed meanwhile.
		let queued = opening.get(m.id)!
		opening.delete(m.id)
		if (!parsers.length) return post({t: "unsupported", id: m.id, reason: `No parser for ${m.lang}`})
		let parser = parsers.find(p => parserFingerprint(p) == m.fp)
		if (!parser) return post({t: "unsupported", id: m.id,
			reason: `${m.lang} is configured differently (${parsers.map(parserFingerprint).join(", ")}, not ${m.fp})`})
		let doc = Text.of(m.text.split("\n"))
		let d = new WorkerDoc(m.id, parser, doc, m.version, m.visible)
		d.touched = ++touch
		if (m.seed) {
			let decoder = new TreeDecoder(), set = d.set, setFp = setFingerprint(set)
			let tree = decoder.decode(m.seed, parser, {set: f => f == setFp ? set : null, mount: nestedParser(new TextInput(doc))})
			d.encoder.adopt(decoder)
			d.tree = tree
			d.treeDoc = doc
			d.treeLen = Math.min(m.seedLen, doc.length)
			d.fragments = TreeFragment.addTree(tree, [], d.treeLen < doc.length)
		}
		docs.set(m.id, d)
		for (let q of queued) handle(q)
		schedule()
	}

	let handle = (m: ToWorker) => {
		if (m.t == "hello") return post({t: "hello", protocol: SYNTAX_PROTOCOL})
		let queued = opening.get(m.id)
		if (queued && m.t != "close") return void queued.push(m)
		try {
			if (m.t == "open") {
				opening.set(m.id, [])
				open(m).catch(e => fail(m.id, e))
				return
			}
			if (m.t == "close") {
				docs.delete(m.id)
				opening.delete(m.id)
				return
			}
			let d = docs.get(m.id)
			if (!d) return
			d.touched = ++touch
			if (m.t == "edit") d.edit(ChangeSet.fromJSON(m.changes), m.version)
			else if (m.t == "visible") d.visibleTo = Math.min(m.to, d.doc.length)
			schedule()
		} catch (e) {
			fail(m.id, e)
		}
	}

	scope.addEventListener("message", e => handle(e.data as ToWorker))
	scope.start?.()
}
