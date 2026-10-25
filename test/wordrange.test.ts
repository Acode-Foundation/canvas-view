import {expect, test} from "bun:test"
import {EditorState} from "@codemirror/state"
import {wordRangeAt} from "../src/view/touchselect"

/// The text `wordRangeAt` selects for a point on the character at
/// `needle`'s index (+ `offset`) in `doc`, or null.
function groupAt(doc: string, needle: string, offset = 0, bias = 1) {
	let state = EditorState.create({doc})
	let i = doc.indexOf(needle)
	if (i < 0) throw new Error(`no ${needle}`)
	let r = wordRangeAt(state, i + offset, bias)
	return r ? doc.slice(r.from, r.to) : null
}

test("words", () => {
	expect(groupAt("let cached = 1", "cached", 2)).toBe("cached")
	// Just past a word's end (before a space) still selects the word.
	expect(groupAt("let cached = 1", " = ")).toBe("cached")
	expect(groupAt("foo(bar)", "(", 0, -1)).toBe("foo")
})

test("symbol runs", () => {
	expect(groupAt("a === b", "===", 1)).toBe("===")
	expect(groupAt("(x) => y", "=>")).toBe("=>")
	expect(groupAt("foo(bar)", "(")).toBe("(")
	expect(groupAt("a?.b", "?.", 1)).toBe("?.")
})

test("emoji are their own group", () => {
	expect(groupAt("log(😀)", "😀")).toBe("😀")
	expect(groupAt("log(😀)", ")", 0, -1)).toBe("😀")
	expect(groupAt("x 😀🎉 y", "🎉")).toBe("😀🎉")
	expect(groupAt("hi👍🏽there", "👍🏽")).toBe("👍🏽")
	expect(groupAt("a 👨‍👩‍👧 b", "👨")).toBe("👨‍👩‍👧")
	expect(groupAt("flag 🇮🇳!", "🇮🇳")).toBe("🇮🇳")
	expect(groupAt("key 1️⃣ x", "1️⃣")).toBe("1️⃣")
	// The neighbouring word wins only when the point is on it.
	expect(groupAt("abc😀", "😀", 0, -1)).toBe("abc")
	expect(groupAt("abc😀", "😀", 0, 1)).toBe("😀")
})

test("whitespace and empty lines", () => {
	expect(groupAt("a    b", "    ", 2)).toBe(null)
	expect(groupAt("one\n\ntwo", "\n\n", 1)).toBe(null)
})
