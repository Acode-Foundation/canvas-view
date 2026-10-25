import {describe, expect, test} from "bun:test"
import {Text} from "@codemirror/state"
import type {GlyphAtlas} from "../src/core/atlas"
import {autoLevel, bidiLevels, lineSide, moveVisually} from "../src/view/bidi"
import {LineLayouts} from "../src/view/layout"
import {LineModel, type TextDirectionMode, type VLine} from "../src/view/lines"
// @ts-ignore: plain JS fixture module, shared with the browser tests
import {bidiFixtures} from "./browser/bidifixtures.mjs"

// A stand-in atlas: emoji are 2 cells, shaped words 1 cell per char.
const wide = /\p{Extended_Pictographic}/u
const atlas = {cellsOf: (g: string) => wide.test(g) ? 2 : 1, shapedCells: (t: string) => t.length} as unknown as GlyphAtlas

function model(text: string, direction: TextDirectionMode = "ltr", wrap = 0, align = 60) {
	let doc = Text.of(text.split("\n"))
	let decos = {joins: [], points: [], blockCount: 0, joinAt: () => -1, pointsIn: () => []}
	let layouts = new LineLayouts(() => atlas, 4)
	let lines = new LineModel({doc, layouts, decos, widgetSpec: () => null, blockRows: () => 1} as any)
	lines.setDirection(direction, align)
	if (wrap) lines.setWrap(wrap)
	return {lines, layouts, vl: lines.vline(1)}
}

/// Units (clusters or chars) of a line, with the x each is drawn at.
function drawn(text: string, direction: TextDirectionMode = "ltr", wrap = 0) {
	let {lines, layouts, vl} = model(text, direction, wrap)
	let clusters = layouts.get(text)
	let units = clusters ? clusters.map(c => ({from: c.from, to: c.to, col: c.col, cells: c.cells, text: c.text}))
		: [...text].map((ch, i) => ({from: i, to: i + 1, col: i, cells: 1, text: ch}))
	return {lines, vl, units: units.map(u => {
		let row = lines.rowAt(vl, u.from, 1)
		let x = vl.bidi ? lines.boxX(vl, row, u.col, u.cells) : u.col - lines.rowStartCol(vl, row) + lines.rowX(vl, row)
		let run = vl.bidi ? lines.runAtCol(vl, row, u.col) : null
		return {...u, row, x, rtl: run ? (run.level & 1) == 1 : false}
	})}
}

/// The line as it reads on screen, left to right (right-to-left units
/// are shown reversed, as the browser draws a shaped word).
function visual(text: string, direction: TextDirectionMode = "ltr") {
	let {units} = drawn(text, direction)
	return units.sort((a, b) => a.x - b.x).map(u => u.rtl ? [...u.text].reverse().join("") : u.text).join("")
}

describe("bidi levels", () => {
	test("left-to-right paragraphs", () => {
		expect(visual("abc שלום def")).toBe("abc םולש def")
		expect(visual("שלום 123 עולם")).toBe("םלוע 123 םולש")
		expect(visual("// مرحبا بالعالم")).toBe("// ملاعلاب ابحرم")
		expect(visual(`let s = "مرحبا";`)).toBe(`let s = "ابحرم";`)
		expect(visual("foo(שלום)")).toBe("foo(םולש)")
		// The classic: quotes between two RTL strings join their run.
		expect(visual(`"שלום" + "עולם"`)).toBe(`"םלוע" + "םולש"`)
		expect(visual("שלום 😀 עולם")).toBe("םלוע 😀 םולש")
	})

	test("numbers keep their order inside right-to-left text", () => {
		expect(visual("السعر 25.50 ريال")).toBe("لاير 25.50 رعسلا")
		expect(visual("עד 15/03/2024")).toBe("15/03/2024 דע")
		expect(visual("4 - 5 = -1 ואז")).toBe("4 - 5 = -1 זאו")
	})

	test("right-to-left paragraphs", () => {
		expect(visual("Hello עולם", "rtl")).toBe("םלוע Hello")
		expect(visual("שלום", "rtl")).toBe("םולש")
		expect(visual("foo(bar);", "rtl")).toBe(";foo(bar)")
	})

	test("auto direction follows the first strong character", () => {
		expect(autoLevel("// שלום")).toBe(1)
		expect(autoLevel("123 abc שלום")).toBe(0)
		expect(autoLevel("   ")).toBe(0)
		expect(visual("// שלום", "auto")).toBe("םולש //")
		expect(visual("x = שלום", "auto")).toBe("x = םולש")
	})

	test("Arabic numbers and dates", () => {
		let levels = bidiLevels("التاريخ ٢٠٢٤/٠٣/١٥", 0)
		expect([...levels.slice(8)].every(l => l == 2)).toBe(true)
	})

	test("left-to-right lines without right-to-left text skip bidi", () => {
		for (let text of ["const x = 1", "\tlet s = 'é 世界 👍🏽'", "नमस्ते दुनिया", ""]) expect(model(text).vl.bidi).toBeNull()
		expect(model("x = 'שלום'").vl.bidi).not.toBeNull()
		expect(model("const x = 1", "rtl").vl.bidi).not.toBeNull()
		expect(model("const x = 1", "auto").vl.bidi).toBeNull()
	})
})

/// Geometry checks for one line: units tile each row without overlap,
/// every x maps to a position drawn at that x, and selections cover
/// exactly the selected units.
function checkGeometry(text: string, direction: TextDirectionMode, wrap: number) {
	let {lines, vl, units} = drawn(text, direction, wrap)
	for (let r = 0; r < vl.rows; r++) {
		let row = units.filter(u => u.row == r).sort((a, b) => a.x - b.x)
		for (let i = 1; i < row.length; i++) expect(row[i].x).toBeCloseTo(row[i - 1].x + row[i - 1].cells, 5)
		if (!row.length) continue
		let left = row[0].x, right = row[row.length - 1].x + row[row.length - 1].cells
		// Clicks land where the cursor is then drawn.
		for (let x = left; x <= right; x += 0.5) {
			let {pos, side} = lines.posInRow(vl, r, x)
			let c = lines.coordsIn(vl, pos, side)
			expect(c.row).toBe(r)
			// Within half the clicked unit (emoji and tabs are wider).
			let unit = row.find(u => x >= u.x && x < u.x + u.cells)
			expect(Math.abs(c.x - x)).toBeLessThanOrEqual(Math.max(0.5, (unit?.cells ?? 1) / 2) + 1e-6)
		}
	}
	// Each position's cursor sits on an edge of a unit next to it.
	for (let pos = 0; pos <= text.length; pos++) {
		if (units.some(u => u.from < pos && u.to > pos)) continue
		for (let side of [-1, 1]) {
			let c = lines.coordsIn(vl, pos, side)
			if (side > 0 && pos == text.length || side < 0 && pos == 0) {
				// Pointing out of the line: its visual end or start.
				let row = units.filter(u => u.row == c.row), xs = row.flatMap(u => [u.x, u.x + u.cells])
				let ltrEnd = (side > 0) == !vl.rtl
				if (row.length) expect(c.x).toBeCloseTo(ltrEnd ? Math.max(...xs) : Math.min(...xs), 5)
				continue
			}
			let edges = units.filter(u => (u.to == pos || u.from == pos) && u.row == c.row).flatMap(u => [u.x, u.x + u.cells])
			if (edges.length) expect(edges.some(e => Math.abs(e - c.x) < 1e-6)).toBe(true)
		}
	}
	// A selection of any two units' range covers exactly those units.
	for (let a = 0; a < units.length; a += 3) for (let b = a; b < units.length; b += 4) {
		let ca = units[a].col, cb = units[b].col + units[b].cells, covered = 0
		lines.colSpans(vl, ca, cb, (_r, _x, w) => { covered += w })
		expect(covered).toBeCloseTo(cb - ca, 5)
	}
}

describe("bidi geometry on real-world lines", () => {
	for (let direction of ["ltr", "rtl", "auto"] as TextDirectionMode[]) for (let wrap of [0, 12, 23]) {
		test(`${direction}, wrap ${wrap || "off"}`, () => {
			for (let text of bidiFixtures as string[]) checkGeometry(text, direction, wrap)
		})
	}

	test("right-to-left rows align to the right", () => {
		let {lines, vl} = model("שלום", "rtl", 0, 40)
		expect(lines.coordsIn(vl, 0, 1).x).toBe(40)
		expect(lines.coordsIn(vl, 4, -1).x).toBe(36)
		let empty = model("", "rtl", 0, 40)
		expect(empty.lines.coordsIn(empty.vl, 0).x).toBe(40)
	})

	test("rows are reordered after wrapping", () => {
		let {vl, units} = drawn("אחת שתיים שלוש ארבע abc", "ltr", 10)
		expect(vl.rows).toBe(3)
		let at = (word: string) => units.find(u => u.text == word)!
		// Each row reads right to left on its own.
		expect(at("אחת").row).toBe(0)
		expect(at("שתיים").row).toBe(0)
		expect(at("אחת").x).toBeGreaterThan(at("שתיים").x)
		expect(at("שלוש").row).toBe(1)
		expect(at("שלוש").x).toBeGreaterThan(at("ארבע").x)
		expect(at("שלוש").x).toBeLessThan(10)
	})
})

describe("visual cursor motion", () => {
	/// Visit a line with CodeMirror's moveVisually from its visual start.
	function walk(text: string, direction: TextDirectionMode) {
		let {lines, vl} = model(text, direction)
		let spans = lines.lineSpans(text), dir = lines.baseLevel(text)
		let cur = {...lineSide(spans, dir, false), level: -1}
		let xs: number[] = [], seen = new Set<number>()
		for (let i = 0; i < text.length * 3; i++) {
			let next = moveVisually(text.length, spans, dir, cur.pos, cur.assoc, cur.level, true,
				(p, f) => f ? p + 1 : p - 1)
			if (!next) break
			cur = next
			seen.add(cur.pos)
			xs.push(lines.coordsIn(vl, cur.pos, cur.assoc).x)
		}
		return {xs, seen}
	}

	test("in right-to-left paragraphs, forward is leftward", () => {
		for (let text of ["Hello עולם", "שלום 123 עולם", "x = 'שלום' + 1"]) {
			let {xs, seen} = walk(text, "rtl")
			for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1] + 1e-6)
			expect(seen.size).toBeGreaterThanOrEqual(text.length)
		}
	})

	test("arrow keys move visually through mixed text", () => {
		for (let text of ["abc שלום def", "שלום 123 עולם", `let s = "مرحبا";`, "עברית English עברית"]) {
			let {xs, seen} = walk(text, "ltr")
			for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] - 1e-6)
			expect(seen.size).toBeGreaterThanOrEqual(text.length)
		}
	})
})
