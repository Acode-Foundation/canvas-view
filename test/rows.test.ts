import {expect, test} from "bun:test"
import {EditorState, Text} from "@codemirror/state"
import type {GlyphAtlas} from "../src/core/atlas"
import {LineLayouts} from "../src/view/layout"
import {LineModel} from "../src/view/lines"

const atlas = {cellsOf: () => 1, shapedCells: (t: string) => t.length} as unknown as GlyphAtlas

function model(doc: Text) {
	let decos = {joins: [], points: [], blockCount: 0, joinAt: () => -1, pointsIn: () => []}
	let host = {doc, layouts: new LineLayouts(() => atlas, 4), decos, widgetSpec: () => null, blockRows: () => 1}
	let lines = new LineModel(host as any)
	lines.setWrap(20)
	return {lines, host}
}

// Lines of 0 to ~120 chars, so they wrap to 1-7 rows.
function makeDoc(n: number) {
	let out: string[] = [], seed = 7
	for (let i = 0; i < n; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		out.push("word ".repeat(seed % 25))
	}
	return Text.of(out)
}

test("idle measuring in short slices matches measuring at once", () => {
	let doc = makeDoc(3000)
	let whole = model(doc).lines
	expect(whole.measureIdle(1500, 1500, Infinity).done).toBe(true)

	// Slices stop inside chunks (every 16 lines past the deadline) and
	// resume where they stopped.
	let sliced = model(doc).lines, steps = 0, above = 0
	for (;;) {
		let res = sliced.measureIdle(1500, 1500, performance.now() + 0.02)
		above += res.above
		if (res.done) break
		if (++steps > 100000) throw new Error("no progress")
	}
	expect(steps).toBeGreaterThan(3)
	expect(sliced.totalRows).toBe(whole.totalRows)
	for (let n = 1; n <= doc.lines; n += 37) expect(sliced.rowOf(n)).toBe(whole.rowOf(n))
	// The rows added above the anchor are reported, so it can be kept in place.
	expect(above).toBe(whole.rowOf(1500) - 1499)
})

test("a slice interrupted by an edit measures its chunk again", () => {
	let doc = makeDoc(1200)
	let {lines, host} = model(doc)
	// Stop part-way through the first chunk.
	if (lines.measureIdle(1, 1, performance.now() + 0.02).done) throw new Error("measured everything in one slice")
	// Replace lines it measured with longer ones, without changing the line count.
	let tr = EditorState.create({doc}).update({changes: {from: 0, to: doc.line(8).to, insert: Array(8).fill("word ".repeat(30)).join("\n")}})
	host.doc = tr.state.doc
	lines.mapChanges(tr.changes, doc, tr.state.doc)
	let fresh = model(tr.state.doc).lines
	fresh.measureIdle(1, 1, Infinity)
	while (!lines.measureIdle(1, 1, performance.now() + 0.02).done) {}
	expect(lines.totalRows).toBe(fresh.totalRows)
	for (let n = 1; n <= 40; n++) expect(lines.rowOf(n)).toBe(fresh.rowOf(n))
})
