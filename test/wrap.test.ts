import {expect, test} from "bun:test"
import {asciiBreaks, wrapIndentColumns} from "../src/view/lines"

/// Rows of `text` wrapped at `cols` with continuation indent `indent`.
function rows(text: string, cols: number, indent = 0) {
	let breaks = asciiBreaks(text, cols, [], indent), out: string[] = [], start = 0
	for (let b of [...breaks, text.length]) {
		out.push(text.slice(start, b))
		start = b
	}
	return out
}

const word = /[\w$'"`]/

function checkRows(text: string, cols: number, indent = 0, hard = false) {
	let r = rows(text, cols, indent)
	expect(r.join("")).toBe(text)
	r.forEach((row, i) => {
		// Fits (trailing spaces may hang).
		expect(row.trimEnd().length).toBeLessThanOrEqual(i ? cols - indent : cols)
		if (i) {
			// Never splits a word, never starts with closing punctuation or a space.
			let prev = r[i - 1]
			if (!hard) expect(word.test(prev[prev.length - 1]) && word.test(row[0])).toBe(false)
			expect(/^[)\]},;.: ]/.test(row)).toBe(false)
		}
	})
	return r
}

test("issue 2504: rows fill up instead of moving the call down whole", () => {
	let r = checkRows(`const response = await fetch("https://api.example.com");`, 28)
	expect(r[0]).toBe("const response = await fetch")
	expect(r[1].startsWith(`("https://`)).toBe(true)
})

test("issue 2510: console.log keeps its opening bracket on the first row", () => {
	let r = checkRows(`  if (ok) console.log("first value", second, third)`, 32)
	expect(r[0].startsWith(`  if (ok) console.log(`)).toBe(true)
	r = checkRows(`  console.log(someLongArgumentName, other)`, 24)
	expect(r[0]).toBe(`  console.log(`)
})

test("breaks around operators, not inside operator runs", () => {
	let r = checkRows("const total=price*quantity+shipping===expected", 20)
	for (let i = 1; i < r.length; i++) expect(/[=*+]$/.test(r[i - 1]) && /^[=*+]/.test(r[i])).toBe(false)
	expect(rows("aaaaaaaaa===bbbbbbbbb", 10)[0]).toBe("aaaaaaaaa")
})

test("member access breaks after the dot", () => {
	let r = checkRows("this.dispatchEvent.something.longer", 20)
	expect(r[0]).toBe("this.dispatchEvent.")
})

test("hard break inside a word only when nothing else fits", () => {
	expect(rows("abcdefghijklmnopqrstuvwxyz", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"])
})

test("indentation alone is never a row", () => {
	let r = checkRows("        averyveryverylongidentifier(arg)", 20, 0, true)
	expect(r[0].trim().length).toBeGreaterThan(0)
})

test("continuation rows get the indent's width less", () => {
	checkRows("    const value = compute(alpha, beta, gamma, delta, epsilon)", 24, 6)
})

test("wrap indent modes", () => {
	expect(wrapIndentColumns("    x", 4, 20, "same")).toBe(4)
	expect(wrapIndentColumns("    x", 4, 20, "indent")).toBe(8)
	expect(wrapIndentColumns("    x", 4, 20, "deepIndent")).toBe(12)
	expect(wrapIndentColumns("    x", 4, 20, 2)).toBe(6)
	expect(wrapIndentColumns("x", 4, 20, 2)).toBe(2)
	expect(wrapIndentColumns("\tx", 4, 20, "same")).toBe(4)
	expect(wrapIndentColumns("                    x", 4, 10, "same")).toBe(10)
	expect(wrapIndentColumns("    x", 4, 20, "none")).toBe(0)
})
