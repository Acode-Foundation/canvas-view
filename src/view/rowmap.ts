/// Rows per document line, for wrapping and folding. Stored in chunks
/// (a shallow B-tree), so an edit splices one chunk and lookups cost a
/// binary search over chunks plus a scan inside one.
///
/// A count of 0 marks a line hidden inside a visual line that starts
/// above it (folded or replaced across line breaks). Chunks are
/// `valid` once every line in them has been measured for the current
/// layout; invalid chunks keep their previous (or placeholder) counts
/// until the line model measures them.

const CHUNK = 512
const MAX_CHUNK = 1024

interface Chunk {
	counts: Int32Array
	len: number
	rows: number
	valid: boolean
}

export class RowMap {
	private chunks: Chunk[] = []
	/// Lines and rows before each chunk, valid below `dirtyFrom`.
	private lineStart = new Float64Array(16)
	private rowStart = new Float64Array(16)
	private dirtyFrom = 0
	private total = 0
	lines = 0

	constructor(lines: number) { this.rebuild(lines) }

	/// Reset to `lines` lines of one row each (invalid unless `valid`).
	rebuild(lines: number, valid = false) {
		this.chunks = []
		for (let at = 0; at < lines; at += CHUNK) {
			let len = Math.min(CHUNK, lines - at)
			let c = newChunk(len, CHUNK)
			c.valid = valid
			this.chunks.push(c)
		}
		if (!this.chunks.length) this.chunks.push(newChunk(0, CHUNK))
		this.lines = lines
		this.dirtyFrom = 0
	}

	get chunkCount() { return this.chunks.length }

	get totalRows() {
		this.fix()
		return this.total
	}

	private fix() {
		let n = this.chunks.length
		if (this.dirtyFrom > n) return
		if (this.lineStart.length < n + 1) {
			let size = Math.max(n + 1, this.lineStart.length * 2)
			let ls = new Float64Array(size), rs = new Float64Array(size)
			ls.set(this.lineStart.subarray(0, this.dirtyFrom))
			rs.set(this.rowStart.subarray(0, this.dirtyFrom))
			this.lineStart = ls
			this.rowStart = rs
		}
		let i = this.dirtyFrom
		let lines = i ? this.lineStart[i - 1] + this.chunks[i - 1].len : 0
		let rows = i ? this.rowStart[i - 1] + this.chunks[i - 1].rows : 0
		for (; i < n; i++) {
			this.lineStart[i] = lines
			this.rowStart[i] = rows
			lines += this.chunks[i].len
			rows += this.chunks[i].rows
		}
		this.lineStart[n] = lines
		this.rowStart[n] = rows
		this.total = rows
		this.dirtyFrom = n + 1
	}

	private dirty(i: number) { if (i < this.dirtyFrom) this.dirtyFrom = i }

	/// Chunk index holding 1-based line `n`, and the line's index in it.
	private find(n: number): {chunk: number, at: number} {
		this.fix()
		let lo = 0, hi = this.chunks.length - 1, line = n - 1
		while (lo < hi) {
			let mid = (lo + hi + 1) >> 1
			if (this.lineStart[mid] <= line) lo = mid
			else hi = mid - 1
		}
		return {chunk: lo, at: line - this.lineStart[lo]}
	}

	count(n: number) {
		let {chunk, at} = this.find(n)
		return this.chunks[chunk].counts[at]
	}

	/// Rows before line `n` (0-based row index of its first row, if it
	/// isn't hidden).
	rowsBefore(n: number) {
		let {chunk, at} = this.find(n)
		let c = this.chunks[chunk], rows = this.rowStart[chunk]
		for (let i = 0; i < at; i++) rows += c.counts[i]
		return rows
	}

	/// The visible line containing 0-based `row` (clamped), and the
	/// rows before it.
	lineAtRow(row: number): {line: number, rowStart: number} {
		this.fix()
		row = Math.max(0, Math.min(this.total - 1, row))
		let lo = 0, hi = this.chunks.length - 1
		while (lo < hi) {
			let mid = (lo + hi + 1) >> 1
			if (this.rowStart[mid] <= row) lo = mid
			else hi = mid - 1
		}
		// Skip chunks with no rows (all hidden).
		while (lo < this.chunks.length - 1 && this.rowStart[lo] + this.chunks[lo].rows <= row) lo++
		let c = this.chunks[lo], rows = this.rowStart[lo], lastVisible = -1, lastStart = rows
		for (let i = 0; i < c.len; i++) {
			let k = c.counts[i]
			if (k > 0) {
				if (row < rows + k) return {line: this.lineStart[lo] + i + 1, rowStart: rows}
				lastVisible = i
				lastStart = rows
			}
			rows += k
		}
		if (lastVisible >= 0) return {line: this.lineStart[lo] + lastVisible + 1, rowStart: lastStart}
		return {line: Math.max(1, this.lineStart[lo] + 1), rowStart: rows}
	}

	/// Replace `remove` lines starting at line `n` with `insert` new
	/// lines (one row each, chunk marked invalid).
	splice(n: number, remove: number, insert: number) {
		let {chunk, at} = this.find(Math.min(n, this.lines + 1))
		if (n > this.lines) {
			chunk = this.chunks.length - 1
			at = this.chunks[chunk].len
		}
		let first = chunk
		// Removal.
		let ci = chunk, o = at, left = remove
		while (left > 0 && ci < this.chunks.length) {
			let c = this.chunks[ci]
			let take = Math.min(left, c.len - o)
			if (take > 0) {
				let gone = 0
				for (let i = o; i < o + take; i++) gone += c.counts[i]
				c.counts.copyWithin(o, o + take, c.len)
				c.len -= take
				c.rows -= gone
				c.valid = false
				left -= take
			}
			if (left > 0) { ci++; o = 0 }
		}
		// Insertion at (chunk, at).
		let c = this.chunks[chunk]
		if (insert > 0) {
			if (c.len + insert <= MAX_CHUNK) {
				if (c.counts.length < c.len + insert) {
					let next = new Int32Array(Math.max(MAX_CHUNK, c.len + insert))
					next.set(c.counts.subarray(0, c.len))
					c.counts = next
				}
				c.counts.copyWithin(at + insert, at, c.len)
				c.counts.fill(1, at, at + insert)
				c.len += insert
				c.rows += insert
				c.valid = false
			} else {
				let tail = newChunk(c.len - at, MAX_CHUNK)
				let tailRows = 0
				for (let i = at; i < c.len; i++) tailRows += (tail.counts[i - at] = c.counts[i])
				tail.rows = tailRows
				c.len = at
				c.rows -= tailRows
				c.valid = false
				let added: Chunk[] = []
				for (let done = 0; done < insert; done += CHUNK) added.push(newChunk(Math.min(CHUNK, insert - done), CHUNK))
				this.chunks.splice(chunk + 1, 0, ...added, tail)
			}
		}
		// Drop emptied chunks (keep at least one).
		for (let i = this.chunks.length - 1; i >= first && this.chunks.length > 1; i--)
			if (!this.chunks[i].len) this.chunks.splice(i, 1)
		this.lines += insert - remove
		this.dirty(first)
		if (this.chunks.length > this.lines / CHUNK * 2 + 32) this.repack()
	}

	/// Merge small chunks left by edits.
	private repack() {
		let out: Chunk[] = []
		for (let c of this.chunks) {
			let last = out[out.length - 1]
			if (last && last.len + c.len <= CHUNK) {
				if (last.counts.length < last.len + c.len) {
					let next = new Int32Array(MAX_CHUNK)
					next.set(last.counts.subarray(0, last.len))
					last.counts = next
				}
				last.counts.set(c.counts.subarray(0, c.len), last.len)
				last.len += c.len
				last.rows += c.rows
				last.valid = last.valid && c.valid
			} else {
				out.push(c)
			}
		}
		this.chunks = out
		this.dirty(0)
	}

	/// Mark the chunks covering lines `a`..`b` for measurement.
	invalidate(a: number, b: number) {
		if (!this.lines) return
		let from = this.find(Math.max(1, a)).chunk, to = this.find(Math.min(this.lines, Math.max(a, b))).chunk
		for (let i = from; i <= to; i++) this.chunks[i].valid = false
	}

	invalidateAll() { for (let c of this.chunks) c.valid = false }

	/// An independent copy (counts and validity).
	clone() {
		let copy = new RowMap(0)
		copy.copyFrom(this)
		return copy
	}

	/// Take `other`'s counts and validity.
	copyFrom(other: RowMap) {
		this.chunks = other.chunks.map(c => ({...c, counts: c.counts.slice()}))
		this.lines = other.lines
		this.dirtyFrom = 0
	}

	/// Chunk index of line `n`.
	chunkOf(n: number) { return this.find(Math.max(1, Math.min(this.lines, n))).chunk }

	isValid(i: number) { return this.chunks[i].valid }

	/// First line (1-based) and length of chunk `i`.
	chunkLines(i: number) {
		this.fix()
		return {first: this.lineStart[i] + 1, len: this.chunks[i].len}
	}

	/// Recompute every count in chunk `i` with `rows(line)`. Returns
	/// the change in rows.
	measure(i: number, rows: (line: number) => number) {
		this.fix()
		let c = this.chunks[i], first = this.lineStart[i] + 1, total = 0
		for (let k = 0; k < c.len; k++) total += (c.counts[k] = rows(first + k))
		let delta = total - c.rows
		c.rows = total
		c.valid = true
		if (delta) this.dirty(i + 1)
		return delta
	}

	/// Set lines `a`..`b` to `count` rows each (keeps validity).
	fill(a: number, b: number, count: number) {
		if (b < a) return
		let {chunk, at} = this.find(a), left = b - a + 1
		this.dirty(chunk + 1)
		for (let ci = chunk; left > 0 && ci < this.chunks.length; ci++, at = 0) {
			let c = this.chunks[ci], end = Math.min(c.len, at + left)
			for (let i = at; i < end; i++) {
				c.rows += count - c.counts[i]
				c.counts[i] = count
			}
			left -= end - at
		}
	}

	/// Set a single line's count (keeps the chunk's validity).
	set(n: number, count: number) {
		let {chunk, at} = this.find(n)
		let c = this.chunks[chunk], delta = count - c.counts[at]
		if (!delta) return 0
		c.counts[at] = count
		c.rows += delta
		this.dirty(chunk + 1)
		return delta
	}
}

function newChunk(len: number, capacity: number): Chunk {
	let counts = new Int32Array(Math.max(capacity, len))
	counts.fill(1, 0, len)
	return {counts, len, rows: len, valid: false}
}
