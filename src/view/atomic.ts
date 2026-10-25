// `EditorView.atomicRanges`: ranges the cursor can't stop inside.
// CodeMirror's view moves pointer selections and cursor motion out of
// them; these are its `skipAtomicRanges` / `skipAtomsForSelection`
// (MIT), so both views put the cursor on the same side.

import {EditorSelection, type RangeSet, type SelectionRange} from "@codemirror/state"

/// Move `pos` out of the atomic ranges it's inside of: toward `bias`
/// (-1 start, 1 end), or to the nearer edge when `bias` is 0.
export function skipAtomicRanges(atoms: readonly RangeSet<any>[], pos: number, bias: number) {
	for (;;) {
		let moved = 0
		for (let set of atoms) {
			set.between(pos - 1, pos + 1, (from, to) => {
				if (pos > from && pos < to) {
					let side = moved || bias || (pos - from < to - pos ? -1 : 1)
					pos = side < 0 ? from : to
					moved = side
				}
			})
		}
		if (!moved) return pos
	}
}

/// A selection with no range end inside an atomic range: cursors go to
/// the nearer edge, ranges grow to cover what they cut into.
export function skipAtomsForSelection(atoms: readonly RangeSet<any>[], sel: EditorSelection) {
	let ranges: SelectionRange[] | null = null
	for (let i = 0; i < sel.ranges.length; i++) {
		let range = sel.ranges[i], updated: SelectionRange | null = null
		if (range.empty) {
			let pos = skipAtomicRanges(atoms, range.from, 0)
			if (pos != range.from) updated = EditorSelection.cursor(pos, -1)
		} else {
			let from = skipAtomicRanges(atoms, range.from, -1)
			let to = skipAtomicRanges(atoms, range.to, 1)
			if (from != range.from || to != range.to)
				updated = range.undirectional ? EditorSelection.undirectionalRange(from, to)
					: EditorSelection.range(range.from == range.anchor ? from : to, range.from == range.head ? from : to)
		}
		if (updated) (ranges ??= sel.ranges.slice())[i] = updated
	}
	return ranges ? EditorSelection.create(ranges, sel.mainIndex) : sel
}
