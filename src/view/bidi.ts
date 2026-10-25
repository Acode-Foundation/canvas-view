// Bidirectional text: Unicode Bidi Algorithm (UAX #9) levels for a
// line, and the visual order of level runs.
//
// The character types, the W/N rules and bracket pairing are adapted
// from CodeMirror's @codemirror/view `bidi.ts` (MIT License, Copyright
// (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and
// others), without isolates, and with a wider character table (Hebrew
// points, combining marks, punctuation, emoji, RLM/LRM, presentation
// forms, astral RTL scripts) so prose and emoji stay in their runs.
//
// Like VS Code and Ace, only lines that need it pay for it: a line
// whose paragraph is left-to-right and that holds no right-to-left
// character is never analyzed (`needsBidi`).

export const enum T { L = 1, R = 2, AL = 4, EN = 8, AN = 16, ES = 32, ET = 64, CS = 128, NI = 256, NSM = 512, Strong = 7, Num = 24 }

// Decode a string with each type encoded as log2(type).
function dec(str: string) {
	let result: number[] = []
	for (let i = 0; i < str.length; i++) result.push(1 << +str[i])
	return result
}
// Character types for codepoints 0 to 0xf8
const LowTypes = dec("88888888888888888888888888888888888666888888787833333333337888888000000000000000000000000008888880000000000000000000000000088888888888888888888888888888888888887866668888088888663380888308888800000000000000000000000800000000000000000000000000000008")
// Unlike CodeMirror's table: "/" is a common separator (dates like
// ٢٠٢٤/٠٣/١٥ stay one number), "+" and "-" European separators.
LowTypes[0x2f] = T.CS
LowTypes[0x2b] = LowTypes[0x2d] = T.ES
// Character types for codepoints 0x600 to 0x6f9
const ArabicTypes = dec("4444448826627288999999999992222222222222222222222222222222222222222222222229999999999999999999994444444444644222822222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222999999949999999229989999223333333333")

// Paired brackets (ASCII only): the closing char for an opening one,
// minus the opening char for a closing one.
const Brackets = new Int16Array(128)
for (let p of ["()", "[]", "{}"]) {
	let l = p.charCodeAt(0), r = p.charCodeAt(1)
	Brackets[l] = r
	Brackets[r] = -l
}

/// The bidi class of a UTF-16 code unit (low surrogates continue the
/// character before them).
export function charType(ch: number): number {
	if (ch <= 0xf7) return LowTypes[ch]
	if (ch < 0x300) return T.L
	if (ch <= 0x36f) return T.NSM
	if (ch < 0x590) return T.L
	if (ch <= 0x5ff) return ch >= 0x591 && ch <= 0x5bd || ch == 0x5bf || ch == 0x5c1 || ch == 0x5c2 || ch == 0x5c4 || ch == 0x5c5 || ch == 0x5c7 ? T.NSM : T.R
	if (ch <= 0x6f9) return ch < 0x600 ? T.R : ArabicTypes[ch - 0x600]
	// Syriac, Thaana, Arabic supplements: AL. N'Ko, Samaritan, Mandaic: R.
	if (ch <= 0x8ff) return ch >= 0x7c0 && ch <= 0x85f ? T.R : T.AL
	if (ch < 0x2000) return T.L
	if (ch <= 0x200b) return T.NI
	if (ch <= 0x200d) return T.NSM // ZWNJ, ZWJ: keep a run (and emoji sequences) together
	if (ch == 0x200e) return T.L
	if (ch == 0x200f) return T.R
	if (ch <= 0x2069) return T.NI // punctuation (dashes, quotes, ellipsis), separators
	if (ch >= 0x20a0 && ch <= 0x20cf) return T.ET // currency
	if (ch >= 0x2190 && ch <= 0x2bff) return T.NI // arrows, math, box drawing, shapes, symbols
	if (ch == 0x3000) return T.NI
	if (ch < 0xd800) return T.L
	if (ch <= 0xdbff) {
		// High surrogates: emoji are neutral; U+10800..10FFF and
		// U+1E800..1EFFF are right-to-left scripts.
		if (ch >= 0xd83c && ch <= 0xd83e) return T.NI
		return ch == 0xd802 || ch == 0xd803 || ch == 0xd83a || ch == 0xd83b ? T.R : T.L
	}
	if (ch <= 0xdfff) return T.NSM
	if (ch < 0xfb1d) return T.L
	if (ch <= 0xfb4f) return T.R
	if (ch <= 0xfdff) return T.AL
	if (ch <= 0xfe0f) return ch >= 0xfe00 ? T.NSM : T.L
	if (ch >= 0xfe70 && ch <= 0xfefe) return T.AL
	return T.L
}

const mirrorPairs = "()[]{}<>\u00ab\u00bb\u2039\u203a\u2264\u2265"
const mirrors: Record<number, number> = Object.create(null)
for (let i = 0; i < mirrorPairs.length; i += 2) {
	mirrors[mirrorPairs.charCodeAt(i)] = mirrorPairs.charCodeAt(i + 1)
	mirrors[mirrorPairs.charCodeAt(i + 1)] = mirrorPairs.charCodeAt(i)
}

/// The mirrored form of a character drawn right-to-left (rule L4:
/// brackets, angle quotes...), or 0.
export function mirrorChar(ch: number): number { return mirrors[ch] ?? 0 }

/// Matches text that holds right-to-left characters.
export const rtlChars = /[֐-ࣿ‏יִ-﷿ﹰ-﻾]|[\ud802\ud803\ud83a\ud83b][\udc00-\udfff]/

/// Whether a code unit is bidi whitespace (WS) or a segment separator
/// (tab), which rule L1 resets to the paragraph level at row ends.
export function isBidiSpace(ch: number) {
	return ch == 32 || ch == 9 || ch >= 0x2000 && ch <= 0x200a || ch == 0x3000 || ch == 0x1680 || ch == 0x205f
}

/// The direction of a paragraph from its first strong character (HTML
/// `dir=auto`, CodeMirror's `perLineTextDirection`): 1 for
/// right-to-left, 0 otherwise.
export function autoLevel(text: string) {
	for (let i = 0; i < text.length; i++) {
		let type = charType(text.charCodeAt(i))
		if (type == T.L) return 0
		if (type == T.R || type == T.AL) return 1
	}
	return 0
}

// Reused array of character types.
const types: number[] = []

// Fill in the character types (in `types`) from `from` to `to` and
// apply W normalization rules.
function computeCharTypes(line: string, rFrom: number, rTo: number, outerType: number) {
	// W1. Examine each non-spacing mark (NSM) in the level run, and
	// change the type of the NSM to the type of the previous
	// character. If the NSM is at the start of the level run, it will
	// get the type of sor.
	// W2. Search backwards from each instance of a European number
	// until the first strong type (R, L, AL, or sor) is found. If an
	// AL is found, change the type of the European number to Arabic
	// number.
	// W3. Change all ALs to R.
	// (Left after this: L, R, EN, AN, ET, CS, NI)
	for (let i = rFrom, prev = outerType, prevStrong = outerType; i < rTo; i++) {
		let ch = line.charCodeAt(i), type = ch <= 0xf7 ? LowTypes[ch] : charType(ch)
		if (type == T.NSM) type = prev
		else if (type == T.EN && prevStrong == T.AL) type = T.AN
		types[i] = type == T.AL ? T.R : type
		if (type & T.Strong) prevStrong = type
		prev = type
	}
	// W4. A single European separator between two European numbers
	// changes to a European number. A single common separator between
	// two numbers of the same type changes to that type.
	// numbers changes to all European numbers.
	// W6. Otherwise, separators and terminators change to Other
	// Neutral.
	// W7. Search backwards from each instance of a European number
	// until the first strong type (R, L, or sor) is found. If an L is
	// found, then change the type of the European number to L.
	// (Left after this: L, R, EN+AN, NI)
	for (let i = rFrom, prev = outerType, prevStrong = outerType; i < rTo; i++) {
		let type = types[i]
		if (type == T.CS || type == T.ES) {
			if (i < rTo - 1 && prev == types[i + 1] && (type == T.CS ? prev & T.Num : prev == T.EN)) type = types[i] = prev
			else types[i] = T.NI
		} else if (type == T.ET) {
			let end = i + 1
			while (end < rTo && types[end] == T.ET) end++
			let replace = (i && prev == T.EN) || (end < rTo && types[end] == T.EN) ? (prevStrong == T.L ? T.L : T.EN) : T.NI
			for (let j = i; j < end; j++) types[j] = replace
			i = end - 1
		} else if (type == T.EN && prevStrong == T.L) {
			types[i] = T.L
		}
		prev = type
		if (type & T.Strong) prevStrong = type
	}
}

const enum Bracketed { OppositeBefore = 1, EmbedInside = 2, OppositeInside = 4, MaxDepth = 3 * 63 }
const BracketStack: number[] = []

// Process brackets throughout a run sequence.
function processBracketPairs(line: string, rFrom: number, rTo: number, outerType: number) {
	let oppositeType = outerType == T.L ? T.R : T.L
	// N0. Process bracket pairs in an isolating run sequence
	// sequentially in the logical order of the text positions of the
	// opening paired brackets using the logic given below. Within this
	// scope, bidirectional types EN and AN are treated as R.
	for (let i = rFrom, sI = 0, context = 0, ch, br, type; i < rTo; i++) {
		// Keeps [startIndex, type, strongSeen] triples for each open
		// bracket on BracketStack.
		if ((ch = line.charCodeAt(i)) < 128 && (br = Brackets[ch])) {
			if (br < 0) { // Closing bracket
				for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
					if (BracketStack[sJ + 1] == -br) {
						let flags = BracketStack[sJ + 2]
						let type = (flags & Bracketed.EmbedInside) ? outerType :
							!(flags & Bracketed.OppositeInside) ? 0 :
							(flags & Bracketed.OppositeBefore) ? oppositeType : outerType
						if (type) types[i] = types[BracketStack[sJ]] = type
						sI = sJ
						break
					}
				}
			} else if (sI == Bracketed.MaxDepth) {
				break
			} else {
				BracketStack[sI++] = i
				BracketStack[sI++] = ch
				BracketStack[sI++] = context
			}
		} else if ((type = types[i]) & (T.R | T.L | T.Num)) {
			// Numbers count as R here (CodeMirror leaves them out).
			let embed = (type == T.L ? T.L : T.R) == outerType
			context = embed ? 0 : Bracketed.OppositeBefore
			for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
				let cur = BracketStack[sJ + 2]
				if (cur & Bracketed.EmbedInside) break
				if (embed) {
					BracketStack[sJ + 2] |= Bracketed.EmbedInside
				} else {
					if (cur & Bracketed.OppositeInside) break
					BracketStack[sJ + 2] |= Bracketed.OppositeInside
				}
			}
		}
	}
}

function processNeutrals(rFrom: number, rTo: number, outerType: number) {
	// N1. A sequence of neutrals takes the direction of the
	// surrounding strong text if the text on both sides has the same
	// direction. European and Arabic numbers act as if they were R in
	// terms of their influence on neutrals. Start-of-level-run (sor)
	// and end-of-level-run (eor) are used at level run boundaries.
	// N2. Any remaining neutrals take the embedding direction.
	// (Left after this: L, R, EN+AN)
	for (let i = rFrom, prev = outerType; i < rTo;) {
		let type = types[i]
		if (type == T.NI) {
			let end = i + 1
			while (end < rTo && types[end] == T.NI) end++
			let beforeL = prev == T.L
			let afterL = (end < rTo ? types[end] : outerType) == T.L
			let replace = beforeL == afterL ? (beforeL ? T.L : T.R) : outerType
			for (let j = i; j < end; j++) types[j] = replace
			i = end
		} else {
			prev = type
			i++
		}
	}
}

/// Resolved embedding levels (one per UTF-16 code unit) of a line in a
/// paragraph of level `base` (0 or 1). Rule L1 (whitespace at row
/// ends) is left to the caller, which knows where rows end.
export function bidiLevels(line: string, base: number): Uint8Array {
	let len = line.length, outerType = base ? T.R : T.L
	computeCharTypes(line, 0, len, outerType)
	processBracketPairs(line, 0, len, outerType)
	processNeutrals(0, len, outerType)
	let levels = new Uint8Array(len)
	// I1, I2: implicit levels.
	for (let i = 0; i < len; i++) {
		let type = types[i]
		levels[i] = base ? (type == T.R ? 1 : 2) : type == T.R ? 1 : type & T.Num ? 2 : 0
	}
	return levels
}

/// A run of one level, in logical positions/columns.
export interface LevelRun {
	from: number
	to: number
	colFrom: number
	colTo: number
	level: number
	/// Visual x (cells) of the run's left edge, from the row's start.
	x: number
}

/// Rule L2: reorder runs (given in logical order) into visual order, in
/// place, and assign their x offsets. Returns the total width.
export function reorderRuns(runs: LevelRun[]) {
	let max = 0, minOdd = 255
	for (let r of runs) {
		if (r.level > max) max = r.level
		if (r.level & 1 && r.level < minOdd) minOdd = r.level
	}
	// From the highest level to the lowest odd one, reverse any
	// contiguous sequence of runs at that level or higher.
	for (let level = max; level >= minOdd; level--) {
		for (let i = 0; i < runs.length;) {
			if (runs[i].level < level) { i++; continue }
			let end = i + 1
			while (end < runs.length && runs[end].level >= level) end++
			for (let a = i, b = end - 1; a < b; a++, b--) {
				let tmp = runs[a]
				runs[a] = runs[b]
				runs[b] = tmp
			}
			i = end
		}
	}
	let x = 0
	for (let r of runs) {
		r.x = x
		x += r.colTo - r.colFrom
	}
	return x
}

/// A level run in visual order, positions relative to the line start
/// (the shape of CodeMirror's `BidiSpan`).
export interface Span { from: number, to: number, level: number }

function spanSide(span: Span, end: boolean, dir: number) { return ((span.level & 1) == dir) == end ? span.to : span.from }
function spanForward(span: Span, forward: boolean, dir: number) { return forward == ((span.level & 1) == dir) }

/// CodeMirror's `BidiSpan.find`: the span holding `index`, preferring
/// `level`, then the side `assoc` points to, then the lowest level.
export function findSpan(order: readonly Span[], index: number, level: number, assoc: number) {
	let maybe = -1
	for (let i = 0; i < order.length; i++) {
		let span = order[i]
		if (span.from <= index && span.to >= index) {
			if (span.level == level) return i
			if (maybe < 0 || (assoc != 0 ? (assoc < 0 ? span.from < index : span.to > index) : order[maybe].level > span.level))
				maybe = i
		}
	}
	return maybe < 0 ? 0 : maybe
}

/// One visual step from `head` (line-relative) through spans in
/// visual order, like CodeMirror's `moveVisually`: `forward` is toward
/// the end of the line in its base direction `dir` (0/1). `next`
/// finds the next cluster break (logically forward or back). Returns
/// null at the line's visual end, else the new position, its assoc
/// and bidi level.
export function moveVisually(length: number, order: readonly Span[], dir: number, head: number, assoc: number, bidiLevel: number,
	forward: boolean, next: (pos: number, forward: boolean) => number): {pos: number, assoc: number, level: number} | null {
	if (!length) return null
	let startIndex = head, spanI: number
	if (head == 0 && assoc < 0) {
		if (!forward) return null
		startIndex = spanSide(order[spanI = 0], false, dir)
	} else if (head == length && assoc > 0) {
		if (forward) return null
		startIndex = spanSide(order[spanI = order.length - 1], true, dir)
	} else {
		spanI = findSpan(order, startIndex, bidiLevel, assoc)
	}
	let span = order[spanI], spanEnd = spanSide(span, forward, dir)
	if (startIndex == spanEnd) {
		let nextI = spanI += forward ? 1 : -1
		if (nextI < 0 || nextI >= order.length) return null
		span = order[spanI = nextI]
		startIndex = spanSide(span, !forward, dir)
		spanEnd = spanSide(span, forward, dir)
	}
	let nextIndex = next(startIndex, spanForward(span, forward, dir))
	if (nextIndex < span.from || nextIndex > span.to) nextIndex = spanEnd
	let nextSpan = spanI == (forward ? order.length - 1 : 0) ? null : order[spanI + (forward ? 1 : -1)]
	if (nextIndex == spanEnd) {
		if (!nextSpan) return forward ? {pos: length, assoc: 1, level: span.level} : {pos: 0, assoc: -1, level: span.level}
		if (nextSpan.level + (forward ? 0 : 1) < span.level)
			return {pos: spanSide(nextSpan, !forward, dir), assoc: spanForward(nextSpan, forward, dir) ? 1 : -1, level: nextSpan.level}
	}
	return {pos: nextIndex, assoc: spanForward(span, forward, dir) ? -1 : 1, level: span.level}
}

/// The visual side of a line: its visual start (`end` false) or end.
export function lineSide(order: readonly Span[], dir: number, end: boolean) {
	let span = order[end ? order.length - 1 : 0]
	return {pos: spanSide(span, end, dir), assoc: spanForward(span, !end, dir) ? 1 : -1}
}
