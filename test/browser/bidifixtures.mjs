// Real-world lines with right-to-left text, for the bidi tests: i18n
// resources, code, markdown, SQL, HTML, CSV, logs, chat, with numbers,
// dates, currency, brackets, quotes, emoji, Hebrew points, Persian
// ZWNJ, Urdu, Syriac, Thaana, and mixed scripts.
export const bidiFixtures = [
	`"greeting": "שלום עולם!",`,
	`"inbox": "יש לך 5 הודעות חדשות",`,
	`"price": "המחיר: ₪249.90 (כולל מע״מ)",`,
	`"items": "لديك 3 عناصر في السلة", "date": "٢٠٢٤/٠٣/١٥"`,
	`"title": "می‌خواهم ۱۲۳ کتاب بخرم",`,
	`"ur": "یہ ایک مثال ہے 👋",`,
	`const msg = "مرحبا بالعالم"; // تحية للمستخدم`,
	`function greet(name) { return \`שלום \${name}, ברוך הבא (3)\` } // ברכה`,
	`label.textContent = "שלב " + (i + 1) + " מתוך 10"`,
	`SELECT * FROM users WHERE name = 'محمد' AND age > 30;`,
	`<p dir="rtl">مرحبا <b>بك</b> في الموقع رقم 7!</p>`,
	`## الفصل 3: مقدمة (الجزء الأول) - Introduction`,
	`# כותרת ראשית: מדריך ל-JavaScript [גרסה 2.0]`,
	`- [ ] משימה: לתקן את הבאג #1234 עד 15/03/2024`,
	`id,name,city,שם,עיר`,
	`42,"أحمد علي","القاهرة",2024-03-15,1500.50`,
	`[2024-03-15 10:22:01] ERROR: فشل الاتصال بالخادم (timeout=30s)`,
	`print(f"שלום {name}, יש לך {n} הודעות")`,
	`בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם`,
	`السعر: ١٢٣٫٤٥ ريال — خصم 20%`,
	`ܫܠܡܐ ܥܠܡܐ (Syriac) and ހެލޯ (Thaana)`,
	`emoji 😀 בתוך טקסט 🎉 עברי 👩🏽‍💻 here`,
	`a = b ? "כן" : "לא"; // ternary`,
	`if (x > 0 && שם.length < 10) { return [א, ב, ג]; }`,
	`url: "https://example.com/שלום?q=عربي&lang=he"`,
	`phone: +972-3-123-4567 טלפון`,
	`עברית English עברית English עברית`,
	`English עברית English עברית English`,
	`مرحبا hello مرحبا 123 world ٤٥٦`,
	`"«اقتباس»" و ‹نص› < > ≤ ≥`,
	`\tשלום\tעולם\t123`,
	`    # הערה עם הזחה`,
	`x = 'א' + 'ב' + 'ג'`,
	`"Hello", said "שלום", and "مرحبا".`,
	`1 + 2 = 3 ואז 4 - 5 = -1`,
	`v1.2.3 גרסה 2.0.1-beta`,
	`ابحث عن: "test" في الملفات (3 نتائج)`,
	`שלום`,
	`مرحبا`,
	`a`,
]

/// In the page: load `lines` into the view with paragraph direction
/// `mode`, and compare the visual order of every line's layout units
/// with Chromium's own bidi (ICU) on a DOM element with the same text
/// and `dir`. Returns the mismatches.
export async function compareWithBrowser(lines, mode) {
	view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: lines.join("\n")}})
	view.reconfigure({textDirection: mode, lineWrapping: false})
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
	let el = document.createElement("div")
	el.style.cssText = "position:absolute;left:0;top:0;white-space:pre;font:14px monospace;visibility:hidden"
	document.body.appendChild(el)
	let mismatches = [], checked = 0
	for (let n = 1; n <= view.state.doc.lines; n++) {
		let text = view.state.doc.line(n).text
		if (!text) continue
		let vl = view.lines.vline(n), clusters = view.layouts.get(text), units = []
		if (!clusters) for (let i = 0; i < text.length; i++) units.push({from: i, to: i + 1, col: i, cells: 1})
		else for (let c of clusters) units.push({from: c.from, to: c.to, col: c.col, cells: c.cells})
		let ours = units.map((u, i) => ({i, x: vl.bidi ? view.lines.boxX(vl, 0, u.col, u.cells) : u.col}))
		el.dir = mode
		el.textContent = text
		let node = el.firstChild, range = document.createRange()
		let theirs = units.map((u, i) => {
			range.setStart(node, u.from)
			range.setEnd(node, u.to)
			// WebKit adds an empty rect where a unit meets a run of the other direction.
			let rect = [...range.getClientRects()].find(r => r.width > 0)
			return {i, x: rect ? rect.left : -1}
		})
		// Whitespace order is ambiguous at run edges in the DOM's rects.
		let keep = u => !/^\s+$/.test(text.slice(units[u.i].from, units[u.i].to))
		let o = ours.filter(keep).sort((a, b) => a.x - b.x).map(u => u.i)
		let t = theirs.filter(keep).sort((a, b) => a.x - b.x).map(u => u.i)
		checked++
		if (o.join() != t.join()) {
			let k = 0
			while (o[k] == t[k]) k++
			let show = list => list.slice(k, k + 6).map(i => text.slice(units[i].from, units[i].to))
			mismatches.push({line: n, text, ours: show(o), chromium: show(t)})
		}
	}
	el.remove()
	return {checked, mismatches}
}
