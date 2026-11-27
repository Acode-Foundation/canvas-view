import {DocInput} from "@codemirror/language"
import {type ChangeSet, type Extension, Facet, type Text} from "@codemirror/state"
import type {NodeSet, Parser, Tree} from "@lezer/common"
import {type FromWorker, SYNTAX_PROTOCOL, type ToWorker} from "../core/syntaxprotocol"
import {type EncodedTree, nestedParser, parserFingerprint, setFingerprint, transferables, TreeDecoder,
	TreeEncoder} from "../core/treecodec"

/// What `syntaxWorker` needs of a worker: a `Worker`, or a `MessagePort`
/// whose other end runs `serveSyntax`.
export interface SyntaxWorkerLike {
	postMessage(message: unknown, transfer: Transferable[]): void
	addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void
	terminate?(): void
	start?(): void
}

export interface SyntaxWorkerOptions {
	/// How long the worker may stay silent while it owes a tree before
	/// it's given up on (ms, default 10000). It reports progress every
	/// 400ms while parsing.
	timeout?: number
}

/// Parse syntax trees in a worker (one running `serveSyntax` from
/// `@acode.app/canvas-view/worker`), so big files and slow devices don't
/// spend the main thread on parsing: the main thread still parses what's
/// on screen right after an edit or when a file opens (so colors come
/// with the text), and leaves the rest of the document to the worker.
///
/// Every failure falls back to parsing on the main thread, as without
/// this extension: the worker can't be created, reports an error, is
/// silent for `timeout` while it owes a tree, speaks another protocol
/// version, sends a tree that doesn't fit this side's parsers, or doesn't
/// have the document's language (or has it configured differently). A
/// failed worker isn't used again; a document it can't parse is parsed on
/// the main thread, and others still use it.
///
/// `create` is called once, when a view first needs the worker; views
/// configured with the same function share it.
export function syntaxWorker(create: () => SyntaxWorkerLike, options: SyntaxWorkerOptions = {}): Extension {
	let client = clients.get(create)
	if (!client) clients.set(create, client = new WorkerClient(create, options.timeout ?? 10_000))
	return syntaxWorkerFacet.of(client)
}

const clients = new WeakMap<() => SyntaxWorkerLike, WorkerClient>()

export const syntaxWorkerFacet = Facet.define<WorkerClient, WorkerClient | null>({
	combine: values => values.length ? values[0] : null
})

/// A document parsed by the worker.
export interface RemoteDoc {
	/// Send an edit (`doc` is the document after it).
	edit(changes: ChangeSet, doc: Text): void
	/// The end of the visible text.
	visible(to: number): void
	close(): void
}

export interface RemoteSpec {
	parser: Parser
	/// The language's name, which the worker knows it by.
	lang: string
	doc: Text
	visible: number
	/// A tree already parsed for `seed.doc` (up to `seed.len`), which
	/// `since` maps to `doc`.
	seed: {tree: Tree, len: number, doc: Text} | null
	since: ChangeSet | null
	/// A tree from the worker: parsed up to `len` for `doc`, which
	/// `since` (null if none) maps to the current document.
	onTree(tree: Tree, len: number, doc: Text, since: ChangeSet | null): void
	/// The worker won't parse this document (any more).
	onFail(reason: string): void
}

/// The visible end is sent again when it moved this far.
const VISIBLE_STEP = 1000

class RemoteDocImpl implements RemoteDoc {
	decoder = new TreeDecoder()
	/// Documents by version, from the one the last tree was for; each
	/// entry's `changes` lead to it from the one before.
	history: {version: number, doc: Text, changes: ChangeSet | null}[] = []
	version = 0
	treeVersion = -1
	treeLen = 0
	closed = false
	private sentVisible: number

	constructor(readonly client: WorkerClient, readonly id: number, readonly spec: RemoteSpec) {
		this.sentVisible = spec.visible
	}

	get owed() {
		if (this.closed) return false
		let doc = this.history[this.history.length - 1].doc
		return doc.length > 0 && !(this.treeVersion == this.version && this.treeLen >= doc.length)
	}

	edit(changes: ChangeSet, doc: Text) {
		if (this.closed) return
		this.version++
		this.history.push({version: this.version, doc, changes})
		this.client.post({t: "edit", id: this.id, version: this.version, changes: changes.toJSON()})
	}

	visible(to: number) {
		if (this.closed || Math.abs(to - this.sentVisible) < VISIBLE_STEP) return
		this.sentVisible = to
		this.client.post({t: "visible", id: this.id, to})
	}

	close() {
		if (this.closed) return
		this.closed = true
		this.client.close(this)
	}

	receive(m: Extract<FromWorker, {t: "tree"}>) {
		if (this.closed) return
		let i = this.history.findIndex(h => h.version == m.version)
		if (i < 0) return this.fail(`Tree for unknown version ${m.version}`)
		let base = this.history[i], parser = this.spec.parser
		let set = (parser as unknown as {nodeSet: NodeSet}).nodeSet, fp = setFingerprint(set)
		let tree: Tree
		try {
			tree = this.decoder.decode(m.tree, parser, {set: f => f == fp ? set : null, mount: nestedParser(new DocInput(base.doc))})
		} catch (e) {
			return this.fail(`Couldn't decode its tree: ${e}`)
		}
		let since: ChangeSet | null = null
		for (let j = i + 1; j < this.history.length; j++) since = since ? since.compose(this.history[j].changes!) : this.history[j].changes
		this.history.splice(0, i)
		this.treeVersion = m.version
		this.treeLen = m.len
		this.spec.onTree(tree, m.len, base.doc, since)
	}

	fail(reason: string, warn = true) {
		if (this.closed) return
		this.close()
		if (warn) console.warn(`canvas-view: the syntax worker can't parse a document, parsing it on the main thread instead. ${reason}`)
		this.spec.onFail(reason)
	}
}

export class WorkerClient {
	private worker: SyntaxWorkerLike | null = null
	private status: "idle" | "starting" | "ready" | "dead" = "idle"
	private queue: {message: ToWorker, transfer: Transferable[]}[] = []
	private docs = new Map<number, RemoteDocImpl>()
	private nextId = 1
	private quiet = 0
	private timer: ReturnType<typeof setInterval> | null = null
	private tick: number
	private limit: number

	constructor(private create: () => SyntaxWorkerLike, timeout: number) {
		this.tick = Math.min(1000, Math.max(10, timeout / 5))
		this.limit = Math.ceil(timeout / this.tick)
	}

	/// The worker failed and isn't used any more.
	get dead() { return this.status == "dead" }

	/// Have the worker parse a document. Null when the worker failed.
	open(spec: RemoteSpec): RemoteDoc | null {
		if (this.status == "idle") this.start()
		if (this.status == "dead") return null
		let doc = new RemoteDocImpl(this, this.nextId++, spec)
		let seed: EncodedTree | null = null, text = spec.doc, seedLen = 0
		if (spec.seed) {
			try {
				let encoder = new TreeEncoder()
				seed = encoder.encode(spec.seed.tree, (spec.parser as unknown as {nodeSet: NodeSet}).nodeSet)
				doc.decoder.adopt(encoder)
				text = spec.seed.doc
				seedLen = spec.seed.len
			} catch {
				seed = null
			}
		}
		doc.history.push({version: 0, doc: text, changes: null})
		this.docs.set(doc.id, doc)
		this.post({t: "open", id: doc.id, lang: spec.lang, fp: parserFingerprint(spec.parser), text: text.toString(),
				   version: 0, visible: spec.visible, seed, seedLen}, seed ? transferables(seed) : [])
		if (seed && spec.since && text !== spec.doc) doc.edit(spec.since, spec.doc)
		this.watch()
		return this.dead ? null : doc
	}

	post(message: ToWorker, transfer: Transferable[] = []) {
		if (this.status == "starting") this.queue.push({message, transfer})
		else if (this.status == "ready") {
			try {
				this.worker!.postMessage(message, transfer)
			} catch (e) {
				this.fail(`Couldn't post to it: ${e}`)
			}
		}
		if (message.t != "close") this.watch()
	}

	close(doc: RemoteDocImpl) {
		if (this.docs.get(doc.id) != doc) return
		this.docs.delete(doc.id)
		this.post({t: "close", id: doc.id})
	}

	private start() {
		this.status = "starting"
		try {
			let worker = this.create()
			worker.addEventListener("message", e => this.receive(e.data as FromWorker))
			// A script that doesn't load gets a plain Event, without a message.
			worker.addEventListener("error", e => this.fail(e?.message ? `It reported an error: ${e.message}` : "It didn't load or threw an error"))
			worker.addEventListener("messageerror", () => this.fail("A message couldn't be read"))
			worker.start?.()
			this.worker = worker
			worker.postMessage({t: "hello", protocol: SYNTAX_PROTOCOL} satisfies ToWorker, [])
		} catch (e) {
			this.fail(`Couldn't create it: ${e}`)
			return
		}
		this.watch()
	}

	private receive(m: FromWorker) {
		if (this.status == "dead") return
		this.quiet = 0
		try {
			if (m.t == "hello") {
				if (m.protocol != SYNTAX_PROTOCOL) return this.fail(`It speaks protocol ${m.protocol}, not ${SYNTAX_PROTOCOL}`)
				if (this.status != "starting") return
				this.status = "ready"
				let queue = this.queue
				this.queue = []
				for (let {message, transfer} of queue) this.post(message, transfer)
			} else if (m.t == "tree") {
				this.docs.get(m.id)?.receive(m)
			} else if (m.t == "unsupported") {
				this.docs.get(m.id)?.fail(m.reason, false)
			} else if (m.t == "error") {
				if (m.id == null) this.fail(m.message)
				else this.docs.get(m.id)?.fail(m.message)
			}
		} catch (e) {
			this.fail(`Its message couldn't be handled: ${e}`)
		}
	}

	/// The watchdog runs while the worker owes something (its hello, or a
	/// tree for a document's latest version).
	private watch() {
		if (this.timer != null || this.status == "dead" || this.status == "idle") return
		this.quiet = 0
		this.timer = setInterval(() => {
			let owed = this.status == "starting" || [...this.docs.values()].some(d => d.owed)
			if (!owed) {
				clearInterval(this.timer!)
				this.timer = null
			} else if (++this.quiet >= this.limit) {
				this.fail(`No reply for ${this.limit * this.tick}ms`)
			}
		}, this.tick)
	}

	private fail(reason: string) {
		if (this.status == "dead") return
		this.status = "dead"
		if (this.timer != null) clearInterval(this.timer)
		this.timer = null
		this.queue = []
		try {
			this.worker?.terminate?.()
		} catch {}
		this.worker = null
		console.warn(`canvas-view: the syntax worker failed, parsing on the main thread instead. ${reason}`)
		let docs = [...this.docs.values()]
		this.docs.clear()
		for (let doc of docs) doc.fail(reason, false)
	}
}
