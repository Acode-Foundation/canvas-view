import {expect, test} from "bun:test"
import {Text} from "@codemirror/state"
import {forcedSpans} from "../src/view/scene"

// 5 lines of 10 chars: line n starts at (n - 1) * 11.
const doc = Text.of(Array.from({length: 5}, () => "a".repeat(10)))
const plain = {vlineStart: (n: number) => n}

test("forced ranges on one line make one span", () => {
	let ranges: number[] = []
	for (let i = 0; i < 10; i++) ranges.push(11 + i, 12 + i)
	expect(forcedSpans(ranges, doc, plain)).toEqual([2, 2])
})

test("forced ranges are sorted and merged, adjacent lines joined", () => {
	expect(forcedSpans([45, 46, 0, 1, 12, 13, 23, 24], doc, plain)).toEqual([1, 3, 5, 5])
	expect(forcedSpans([0, 1, 33, 34], doc, plain)).toEqual([1, 1, 4, 4])
	// A range across lines covers them all.
	expect(forcedSpans([5, 30, 15, 16], doc, plain)).toEqual([1, 3])
})

test("forced ranges start at their visual line and skip the document's end", () => {
	// Lines 2-4 joined by a fold: a range on line 3 re-emits from line 2.
	let folded = {vlineStart: (n: number) => n >= 2 && n <= 4 ? 2 : n}
	expect(forcedSpans([25, 26], doc, folded)).toEqual([2, 3])
	expect(forcedSpans([100, 101, 50, 200], doc, plain)).toEqual([5, 5])
	expect(forcedSpans([], doc, plain)).toEqual([])
})
