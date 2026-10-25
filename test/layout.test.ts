import {describe, expect, test} from "bun:test"
import type {GlyphAtlas} from "../src/core/atlas"
import {ClusterKind, LineLayouts, retab, tabCells} from "../src/view/layout"

// A stand-in atlas: CJK/emoji are 2 cells, shaped runs 1 cell per char.
const wide = /[　-鿿가-힣]|\p{Extended_Pictographic}/u
const atlas = {
	cellsOf: (g: string) => wide.test(g) ? 2 : 1,
	shapedCells: (t: string) => t.length
} as unknown as GlyphAtlas
const layouts = () => new LineLayouts(() => atlas, 4)

describe("LineLayouts", () => {
	test("printable ASCII needs no layout", () => {
		let l = layouts()
		expect(l.get("const x = 1")).toBeNull()
		expect(l.columnAt("abc", 2)).toBe(2)
		expect(l.offsetAtColumn("abc", 1.4)).toBe(1)
		expect(l.offsetAtColumn("abc", 99)).toBe(3)
		expect(l.offsetAtColumn("abc", -3)).toBe(0)
	})

	test("tabs advance to tab stops", () => {
		let l = layouts()
		let text = "\tx\ty"
		expect(l.columnAt(text, 0)).toBe(0)
		expect(l.columnAt(text, 1)).toBe(4)
		expect(l.columnAt(text, 2)).toBe(5)
		expect(l.columnAt(text, 3)).toBe(8)
		expect(l.width(text)).toBe(9)
		// Clicking in the first half of a tab lands before it.
		expect(l.offsetAtColumn(text, 1)).toBe(0)
		expect(l.offsetAtColumn(text, 3)).toBe(1)
		expect(l.offsetAtColumn(text, 4.2)).toBe(1)
	})

	test("tabs stop at least half a cell away", () => {
		expect(tabCells(0, 4)).toBe(4)
		expect(tabCells(3, 4)).toBe(1)
		expect(tabCells(3.4, 4)).toBeCloseTo(0.6)
		expect(tabCells(3.9, 4)).toBeCloseTo(4.1)
		expect(tabCells(-1, 4)).toBe(1)
	})

	test("retab moves tabs to other stops from an offset", () => {
		let l = layouts()
		let text = "ab\tc\td", clusters = l.get(text)!
		// Unshifted, or by whole tab stops: the same array.
		expect(retab(clusters, 2, 0, 4)).toBe(clusters)
		expect(retab(clusters, 2, 8, 4)).toBe(clusters)
		// "ab" drawn 3 cells further right (a widget before the tab): the
		// tab ends at 8 on screen, column 5 here, and "c" follows it.
		let moved = retab(clusters, 2, 3, 4)
		expect(l.columnAt(text, 3, moved)).toBe(5)
		expect(l.columnAt(text, 5, moved)).toBe(9)
		expect(l.columnAt(text, 2, moved)).toBe(2)
		expect(l.offsetAtColumn(text, 5.2, moved)).toBe(3)
		// The cached layout is untouched.
		expect(l.columnAt(text, 3)).toBe(4)
	})

	test("wide characters take two cells", () => {
		let l = layouts()
		let text = "a世界b"
		expect(l.columnAt(text, 1)).toBe(1)
		expect(l.columnAt(text, 2)).toBe(3)
		expect(l.columnAt(text, 3)).toBe(5)
		expect(l.offsetAtColumn(text, 3.9)).toBe(2)
		expect(l.offsetAtColumn(text, 4.1)).toBe(3)
	})

	test("grapheme clusters are never split", () => {
		let l = layouts()
		let text = "x👩🏽‍💻y"
		let clusters = l.get(text)!
		expect(clusters.map(c => c.text)).toEqual(["x", "👩🏽‍💻", "y"])
		expect(l.columnAt(text, text.length - 1)).toBe(3)
		// Positions inside the cluster map to its start.
		expect(l.offsetAtColumn(text, 1.2)).toBe(1)
		expect(l.offsetAtColumn(text, 2.8)).toBe(text.length - 1)
	})

	test("fallback glyphs keep fractional advances", () => {
		let frac = {cellsOf: (g: string) => /[\u3000-\u9fff]/.test(g) ? 1.67 : 1, shapedCells: (t: string) => t.length * 0.8} as unknown as GlyphAtlas
		let l = new LineLayouts(() => frac, 4)
		let text = "a界b\tc"
		expect(l.columnAt(text, 2)).toBeCloseTo(2.67)
		expect(l.columnAt(text, 3)).toBeCloseTo(3.67)
		// The tab advances to the next stop from a fractional column, the
		// one after when it's less than half a cell away (like Chromium).
		expect(l.columnAt(text, 4)).toBeCloseTo(8)
		expect(l.columnAt("界\tc", 2)).toBeCloseTo(4)
		expect(l.offsetAtColumn(text, 2.6)).toBe(2)
		expect(l.offsetAtColumn(text, 1.5)).toBe(1)
		let hindi = "नमस्ते x"
		// The run is shaped; the space after it is an ordinary cell.
		expect(l.columnAt(hindi, hindi.length - 1)).toBeCloseTo("नमस्ते".length * 0.8 + 1)
	})

	test("control characters get one cell", () => {
		let l = layouts()
		let clusters = l.get("a\u0001b")!
		expect(clusters[1].kind).toBe(ClusterKind.Control)
		expect(clusters[1].text).toBe("␁")
		expect(l.columnAt("a\u0001b", 2)).toBe(2)
	})

	test("Devanagari words are shaped as one run", () => {
		let l = layouts()
		let text = `"दुनिया" x`
		let clusters = l.get(text)!
		let shaped = clusters.filter(c => c.kind == ClusterKind.Shaped)
		expect(shaped.map(c => c.text)).toEqual(["दुनिया"])
		expect(l.columnAt(text, text.indexOf('" x'))).toBe(1 + "दुनिया".length)
	})

	test("shaped runs are words: no spaces or punctuation", () => {
		let l = layouts()
		let text = `{مرحبا بك: "عالم"}`
		let shaped = l.get(text)!.filter(c => c.kind == ClusterKind.Shaped).map(c => c.text)
		expect(shaped).toEqual(["مرحبا", "بك", "عالم"])
	})

	test("shaped runs never mix right-to-left and left-to-right scripts", () => {
		let l = layouts()
		let shaped = l.get("שלוםनमस्ते")!.filter(c => c.kind == ClusterKind.Shaped).map(c => c.text)
		expect(shaped).toEqual(["שלום", "नमस्ते"])
	})

	test("emoji ZWJ sequences don't start shaped runs", () => {
		let l = layouts()
		let clusters = l.get("👩‍💻")!
		expect(clusters.every(c => c.kind == ClusterKind.Text)).toBe(true)
	})

	test("each word is its own shaped run; very long words are split", () => {
		let l = layouts()
		let words = Array.from({length: 20}, () => "नमस्ते").join(" ")
		let shaped = l.get(words)!.filter(c => c.kind == ClusterKind.Shaped)
		expect(shaped.map(c => c.text)).toEqual(Array.from({length: 20}, () => "नमस्ते"))
		let long = "ب".repeat(100)
		let pieces = l.get(long)!
		expect(pieces.length).toBeGreaterThan(1)
		expect(pieces.map(c => c.text).join("")).toBe(long)
	})

	test("column/offset round trip at every cluster boundary", () => {
		let l = layouts()
		for (let text of ["\tconst 世界 = '👍🏽'", "a\tb\tc", "é = é", "x دنيا y नमस्ते z"]) {
			let clusters = l.get(text) ?? []
			for (let c of clusters) {
				let col = l.columnAt(text, c.from)
				expect(l.offsetAtColumn(text, col)).toBe(c.from)
			}
			expect(l.offsetAtColumn(text, l.width(text))).toBe(text.length)
		}
	})
})
