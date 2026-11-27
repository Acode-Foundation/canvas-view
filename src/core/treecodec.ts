import {type Input, IterMode, MountedTree, NodeProp, NodeType, type NodeSet, type Parser, type ParseWrapper,
	type PartialParse, parseMixed, type SyntaxNode, Tree, TreeBuffer, type TreeCursor} from "@lezer/common"

// Syntax trees sent between a worker that parses and the main thread,
// as exact structural copies: every Tree's type, length, children,
// positions and per-node props (look-ahead and context hashes, so
// incremental reparses from them behave like from the original; where a
// stopped mixed parse ended), every TreeBuffer's content, and mounted
// trees (parseMixed). Node types are sent as (node set, id): the
// receiving side has its own parsers and maps their node sets by
// fingerprint, so its trees carry its own NodeTypes and their props
// (highlighting, folding, indentation), and its mounted trees its own
// parsers (incremental reparses reuse a mounted tree only for the same
// parser object).
//
// Trees and buffers already sent are referenced by id, so after an edit
// only what the reparse didn't reuse is sent again.

/// Node set fingerprint: the number of types and a hash of their names.
export function setFingerprint(set: NodeSet): string {
	let h = 5381
	for (let t of set.types) {
		let name = t.name
		for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) | 0
		h = (h * 33 + 44) | 0
	}
	return set.types.length + ":" + (h >>> 0).toString(36)
}

/// A parser's identity for checking that both sides parse alike: its
/// node set, dialect, top rule and how many wrappers (parseMixed) it has.
export function parserFingerprint(parser: Parser): string {
	let p = parser as {nodeSet?: NodeSet, wrappers?: readonly unknown[], dialect?: {source?: string}, top?: readonly number[]}
	return (p.nodeSet ? setFingerprint(p.nodeSet) : "?") + "/" + (p.wrappers?.length ?? 0) + "/" +
		(p.dialect?.source ?? "") + "/" + (p.top?.[1] ?? "")
}

/// A prop's numeric id (Lezer's per-node prop storage key; not in its
/// public types).
function propId(prop: NodeProp<any>): number { return (prop as unknown as {id: number}).id }

let stoppedInner: number | null | undefined

/// The id of @lezer/common's (unexported) prop marking where a stopped
/// mixed parse ended, found from the tree such a parse returns.
function stoppedInnerId(): number | null {
	if (stoppedInner !== undefined) return stoppedInner
	stoppedInner = null
	try {
		let empty = new Tree(NodeType.none, [], [], 0)
		let base: PartialParse = {advance: () => empty, parsedPos: 0, stopAt() {}, stoppedAt: null}
		let parse = parseMixed(() => null)(base, emptyInput, [], [{from: 0, to: 0}])
		parse.stopAt(0)
		let tree: Tree | null = null
		for (let i = 0; i < 10 && !tree; i++) tree = parse.advance()
		let known = [propId(NodeProp.lookAhead), propId(NodeProp.contextHash), propId(NodeProp.mounted)]
		for (let [id] of tree?.propValues ?? []) {
			let n = typeof id == "number" ? id : propId(id)
			if (!known.includes(n)) stoppedInner = n
		}
	} catch {}
	return stoppedInner
}

const emptyInput: Input = {length: 0, chunk: () => "", lineChunks: false, read: () => ""}

/// Per-node props an encoded tree carries, by their code in records.
/// Ids are per @lezer/common instance (a worker bundle has its own), so
/// records name props by code instead.
function propCodes(): number[] {
	let codes = [propId(NodeProp.lookAhead), propId(NodeProp.contextHash)]
	let stopped = stoppedInnerId()
	if (stopped != null) codes.push(stopped)
	return codes
}

const REC_TREE = 1, REC_BUFFER = 2, REC_REF = 3

export interface EncodedTree {
	/// The records, flat (see `TreeEncoder`).
	data: Float64Array
	/// Every buffer's content, one after the other.
	buffer: Uint16Array
	/// Fingerprints of the node sets, by the index records use (-1 is
	/// `NodeType.none`).
	sets: string[]
	/// Ids the receiver can forget.
	released: number[]
}

/// What to transfer when posting an encoded tree (its arrays belong to
/// it alone).
export function transferables(enc: EncodedTree): ArrayBuffer[] {
	return [enc.data.buffer as ArrayBuffer, enc.buffer.buffer as ArrayBuffer]
}

/// Encodes trees for one receiver, remembering what it has.
///
/// Records, in preorder:
/// - Tree: `REC_TREE, id, set, type, length, children, (position, child
///   record)*, props, (prop code, value)*, mounted?` and, if mounted,
///   `set, bracketed, overlay ranges or -1, (from, to)*, length of the
///   inner tree's records, inner tree record`
/// - Buffer: `REC_BUFFER, id, set, offset, size, length`
/// - `REC_REF, id`: something sent before
export class TreeEncoder {
	private sent = new Map<Tree | TreeBuffer, {id: number, mount: MountedTree | null}>()
	private nextId = 1
	private sets: NodeSet[] = []
	private fingerprints: string[] = []
	private data: number[] = []
	private buffers: Uint16Array[] = []
	private bufferSize = 0
	private live = new Set<number>()
	private codes = new Map<number, number>()

	constructor() {
		propCodes().forEach((id, code) => this.codes.set(id, code))
	}

	/// Encode `tree`. What the receiver has stays known (not released)
	/// while it's in `tree` or in `keep`: trees the sender may still reuse
	/// nodes of (its parse's fragments). Releasing those, a later tree
	/// reusing them would send them again in full.
	encode(tree: Tree, set: NodeSet, keep: readonly Tree[] = []): EncodedTree {
		this.data = []
		this.buffers = []
		this.bufferSize = 0
		this.live = new Set()
		this.tree(tree, set)
		let seen = new Set<Tree>()
		for (let k of keep) this.keepLive(k, seen)
		let released: number[] = []
		for (let [obj, {id}] of this.sent) if (!this.live.has(id)) {
			released.push(id)
			this.sent.delete(obj)
		}
		let buffer = new Uint16Array(this.bufferSize), at = 0
		for (let b of this.buffers) {
			buffer.set(b, at)
			at += b.length
		}
		let data = Float64Array.from(this.data)
		this.data = []
		this.buffers = []
		return {data, buffer, sets: this.fingerprints.slice(), released}
	}

	/// Take over what a decoder decoded (a tree the other side sent), so
	/// sending trees reusing it doesn't send it back.
	adopt(decoder: TreeDecoder) {
		for (let [id, obj] of decoder.known()) {
			this.sent.set(obj, {id, mount: obj instanceof Tree ? obj.prop(NodeProp.mounted) ?? null : null})
			this.nextId = Math.max(this.nextId, id + 1)
		}
	}

	/// What the receiver has, by id.
	known(): Iterable<[number, Tree | TreeBuffer]> {
		let out: [number, Tree | TreeBuffer][] = []
		for (let [obj, {id}] of this.sent) out.push([id, obj])
		return out
	}

	private setIndex(set: NodeSet) {
		let i = this.sets.indexOf(set)
		if (i < 0) {
			i = this.sets.length
			this.sets.push(set)
			this.fingerprints.push(setFingerprint(set))
		}
		return i
	}

	private typeSet(type: NodeType, set: NodeSet) {
		if (type == NodeType.none) return -1
		if (set.types[type.id] != type) throw new Error(`Node type ${type.name} isn't in its tree's node set`)
		return this.setIndex(set)
	}

	private ref(obj: Tree | TreeBuffer, mount: MountedTree | null) {
		let known = this.sent.get(obj)
		// A tree reused by a parse can be mounted again (parseMixed patches
		// the node); then it's sent again.
		if (known && known.mount == mount) {
			this.data.push(REC_REF, known.id)
			this.markLive(obj)
			return true
		}
		let id = this.nextId++
		this.sent.set(obj, {id, mount})
		this.live.add(id)
		return id
	}

	/// What the receiver has in `tree` stays in use.
	private keepLive(tree: Tree, seen: Set<Tree>) {
		if (seen.has(tree)) return
		seen.add(tree)
		if (this.sent.has(tree)) return this.markLive(tree)
		for (let child of tree.children) {
			if (child instanceof Tree) this.keepLive(child, seen)
			else if (this.sent.has(child)) this.markLive(child)
		}
		let mount = tree.prop(NodeProp.mounted)
		if (mount) this.keepLive(mount.tree, seen)
	}

	/// What a referenced tree contains stays in use too.
	private markLive(obj: Tree | TreeBuffer) {
		let known = this.sent.get(obj)
		if (!known || this.live.has(known.id)) return
		this.live.add(known.id)
		if (obj instanceof Tree) {
			for (let child of obj.children) this.markLive(child)
			let mount = obj.prop(NodeProp.mounted)
			if (mount) this.markLive(mount.tree)
		}
	}

	private tree(tree: Tree, set: NodeSet) {
		let mount = tree.prop(NodeProp.mounted) ?? null
		let id = this.ref(tree, mount)
		if (id === true) return
		let d = this.data
		d.push(REC_TREE, id, this.typeSet(tree.type, set), tree.type.id, tree.length, tree.children.length)
		for (let i = 0; i < tree.children.length; i++) {
			d.push(tree.positions[i])
			let child = tree.children[i]
			if (child instanceof TreeBuffer) this.buffer(child)
			else this.tree(child, set)
		}
		let propsAt = d.length
		d.push(0)
		for (let [prop, value] of tree.propValues) {
			let code = this.codes.get(typeof prop == "number" ? prop : propId(prop))
			if (code == null || typeof value != "number") continue
			d.push(code, value)
			d[propsAt]++
		}
		if (!mount) {
			d.push(0)
			return
		}
		let inner = (mount.parser as {nodeSet?: NodeSet}).nodeSet
		if (!inner) throw new Error("Mounted tree from a parser without a node set")
		d.push(1, this.setIndex(inner), mount.bracketed ? 1 : 0, mount.overlay ? mount.overlay.length : -1)
		if (mount.overlay) for (let r of mount.overlay) d.push(r.from, r.to)
		let lengthAt = d.length
		d.push(0)
		this.tree(mount.tree, inner)
		d[lengthAt] = d.length - lengthAt - 1
	}

	private buffer(buf: TreeBuffer) {
		let id = this.ref(buf, null)
		if (id === true) return
		this.data.push(REC_BUFFER, id, this.setIndex(buf.set), this.bufferSize, buf.buffer.length, buf.length)
		this.buffers.push(buf.buffer)
		this.bufferSize += buf.buffer.length
	}
}

/// A tree a mounted tree is in: its parser, and where it starts.
export interface MountContainer {parser: Parser, tree: Tree, from: number}

/// What the decoder needs from the receiving side: its node set for a
/// fingerprint (its root language's; null when unknown), and the parser
/// that mounted a tree on `target` (a node starting at `from`, in
/// `container`), whose node set has that fingerprint.
export interface DecodeContext {
	set(fingerprint: string): NodeSet | null
	mount(container: MountContainer, target: Tree, from: number, fingerprint: string): Parser | null
}

/// Rebuilds trees from `TreeEncoder` output, keeping what it decoded so
/// later trees can reference it.
export class TreeDecoder {
	private objects = new Map<number, Tree | TreeBuffer>()
	private codes = propCodes()

	/// Decode a tree parsed by `parser` (the root language's). Throws when
	/// the records don't fit the receiving side's parsers.
	decode(enc: EncodedTree, parser: Parser, ctx: DecodeContext): Tree {
		let pos = 0, data = enc.data
		let sets = enc.sets.map(f => ctx.set(f))
		let mounts: {target: Tree, from: number, set: number, bracketed: boolean, overlay: {from: number, to: number}[] | null,
					 start: number, container: MountContainer}[] = []
		let container: MountContainer = {parser, tree: Tree.empty, from: 0}
		let added: number[] = []
		let setOf = (i: number) => {
			if (i < 0) return null
			let s = sets[i]
			if (!s) throw new Error(`Unknown node set ${enc.sets[i]}`)
			return s
		}
		let read = (offset: number): Tree | TreeBuffer => {
			let kind = data[pos++], id = data[pos++]
			if (kind == REC_REF) {
				let obj = this.objects.get(id)
				if (!obj) throw new Error(`Unknown tree ${id}`)
				return obj
			}
			if (kind == REC_BUFFER) {
				let set = setOf(data[pos++])!, from = data[pos++], size = data[pos++], length = data[pos++]
				if (from + size > enc.buffer.length) throw new Error("Buffer out of range")
				let tb = new TreeBuffer(enc.buffer.subarray(from, from + size), length, set)
				this.objects.set(id, tb)
				added.push(id)
				return tb
			}
			if (kind != REC_TREE) throw new Error(`Bad record ${kind}`)
			let setI = data[pos++], typeId = data[pos++], length = data[pos++], count = data[pos++]
			let set = setOf(setI), type = set ? set.types[typeId] : NodeType.none
			if (!type) throw new Error(`Unknown node type ${typeId}`)
			let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
			for (let i = 0; i < count; i++) {
				let p = data[pos++]
				positions.push(p)
				children.push(read(offset + p))
			}
			let props: [number, number][] = []
			for (let n = data[pos++]; n > 0; n--) {
				let id = this.codes[data[pos++]], value = data[pos++]
				if (id != null) props.push([id, value])
			}
			let self = new Tree(type, children, positions, length, props.length ? props : undefined)
			if (data[pos++]) {
				let mset = data[pos++], bracketed = data[pos++] == 1, nOverlay = data[pos++]
				let overlay: {from: number, to: number}[] | null = null
				if (nOverlay >= 0) {
					overlay = []
					for (let i = 0; i < nOverlay; i++) overlay.push({from: data[pos++], to: data[pos++]})
				}
				let len = data[pos++]
				mounts.push({target: self, from: offset, set: mset, bracketed, overlay, start: pos, container})
				pos += len
			}
			this.objects.set(id, self)
			added.push(id)
			return self
		}
		try {
			let root = read(0)
			if (!(root instanceof Tree)) throw new Error("Root isn't a tree")
			if (pos != data.length) throw new Error("Trailing records")
			container.tree = root
			// Mounted trees, outermost first: the parser that mounted one is
			// found from the tree it's in, with what's mounted around it in
			// place. Mounts inside it are queued after it.
			for (let i = 0; i < mounts.length; i++) {
				let m = mounts[i]
				let found = ctx.mount(m.container, m.target, m.from, enc.sets[m.set])
				let set = found && (found as {nodeSet?: NodeSet}).nodeSet
				if (!found || !set) throw new Error(`No parser for nested node set ${enc.sets[m.set]}`)
				sets[m.set] = set
				// Mounted trees start at their node, overlays at the first range
				// (as Lezer enters them).
				let start = m.from + (m.overlay ? m.overlay[0].from : 0)
				container = {parser: found, tree: Tree.empty, from: start}
				pos = m.start
				let inner = read(start)
				if (!(inner instanceof Tree)) throw new Error("Mounted tree isn't a tree")
				container.tree = inner
				let props = Object.assign(Object.create(null), (m.target as any).props)
				props[propId(NodeProp.mounted)] = new MountedTree(inner, m.overlay, found, m.bracketed)
				;(m.target as any).props = props
			}
			for (let id of enc.released) this.objects.delete(id)
			return root
		} catch (e) {
			// Leave nothing half-decoded to reference.
			for (let id of added) this.objects.delete(id)
			throw e
		}
	}

	/// Take over what an encoder sent (a tree this side sent the other,
	/// which may come back in its trees).
	adopt(encoder: TreeEncoder) {
		for (let [id, obj] of encoder.known()) this.objects.set(id, obj)
	}

	known(): Iterable<[number, Tree | TreeBuffer]> { return this.objects }
}

type Nest = (node: TreeCursor, input: Input) => {parser: Parser, overlay?: unknown, bracketed?: boolean} | null

const nests = new WeakMap<ParseWrapper, Nest | null>()

/// The `nest` function of a `parseMixed` wrapper (kept by the parse it
/// creates), or null for other wrappers.
function nestOf(wrapper: ParseWrapper): Nest | null {
	let nest = nests.get(wrapper)
	if (nest === undefined) {
		nest = null
		try {
			let base: PartialParse = {advance: () => null, parsedPos: 0, stopAt() {}, stoppedAt: null}
			let parse = wrapper(base, emptyInput, [], [{from: 0, to: 0}]) as {nest?: unknown}
			if (typeof parse.nest == "function") nest = parse.nest as Nest
		} catch {}
		nests.set(wrapper, nest)
	}
	return nest
}

type NodeCtor = new (tree: Tree, from: number, index: number, parent: null) => SyntaxNode

/// Finds the parser that mounted a tree by asking the container parser's
/// `parseMixed` wrappers, as its parse did: each `nest` gets a cursor on
/// the target node, made the way the mixed parse makes it (a root node at
/// the container's start, anonymous nodes included, mounts ignored), and
/// the document as input.
export function nestedParser(input: Input) {
	return (container: MountContainer, target: Tree, from: number, fingerprint: string): Parser | null => {
		let wrappers = (container.parser as {wrappers?: readonly ParseWrapper[]}).wrappers
		if (!wrappers?.length) return null
		let Node = Tree.empty.topNode.constructor as NodeCtor
		let cursor = new Node(container.tree, container.from, 0, null).cursor(IterMode.IncludeAnonymous | IterMode.IgnoreMounts)
		if (!seek(cursor, target, from, from + target.length)) return null
		for (let i = wrappers.length - 1; i >= 0; i--) {
			let nest = nestOf(wrappers[i])
			let found = nest && nest(cursor, input)
			let set = found && (found.parser as {nodeSet?: NodeSet}).nodeSet
			if (set && setFingerprint(set) == fingerprint) return found!.parser
		}
		return null
	}
}

/// Move `cursor` to the node holding `target`, which spans `from..to`.
function seek(cursor: TreeCursor, target: Tree, from: number, to: number): boolean {
	if (cursor.tree === target && cursor.from == from) return true
	if (!cursor.firstChild()) return false
	do {
		if (cursor.from > from) break
		if (cursor.to >= to && cursor.tree && seek(cursor, target, from, to)) return true
	} while (cursor.nextSibling())
	cursor.parent()
	return false
}
