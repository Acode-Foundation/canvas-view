// Deterministic generated documents for demos and benchmarks.

const jsBlock = (i: number) => `// Section ${i}: request handling and caching helpers
import {fetchJSON as fetch${i}, Cache as Cache${i}} from "./lib/module-${i % 97}.js"

/**
 * Resolves a resource with retries.
 * @param {string} url The address to load
 */
export async function loadResource${i}(url, {retries = 3, timeout = ${1000 + i % 5000}} = {}) {
	const cache = new Cache${i}({max: ${64 + i % 512}, ttl: 60_000})
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const cached = cache.get(url)
			if (cached !== undefined) return cached
			const result = await fetch${i}(\`\${url}?attempt=\${attempt}&id=${i}\`, {timeout})
			cache.set(url, result)
			return result
		} catch (error) {
			if (!/timeout|reset/i.test(String(error))) throw error
			console.warn("retrying", url, attempt, error?.message ?? "unknown")
		}
	}
	return null
}

class Widget${i} extends EventTarget {
	#state = {count: 0, label: 'widget-${i}', enabled: true, ratio: ${(i % 100) / 7}}
	static defaults = Object.freeze({color: "#${(0x100000 + i * 2654435761 % 0xefffff).toString(16).slice(0, 6)}", size: ${i % 48}})

	get label() { return this.#state.label }

	increment(step = 1) {
		this.#state.count += step * (this.#state.enabled ? 1 : 0)
		this.dispatchEvent(new CustomEvent("change", {detail: {...this.#state}}))
		return this.#state.count > ${i % 1000} ? "overflow" : null
	}
}

`

const htmlBlock = (i: number) => `<section id="part-${i}" class="card ${i % 2 ? "odd" : "even"}" data-index="${i}">
  <h2 class="title">Part ${i} &mdash; overview</h2>
  <p>This paragraph describes <strong>item ${i}</strong> with a <a href="https://example.com/${i}">link</a>.</p>
  <ul>
    <li><input type="checkbox" name="opt-${i}" checked> Option one</li>
    <li><input type="text" placeholder="Value ${i}" value=""></li>
  </ul>
  <style>
    #part-${i} .title { color: #${(i * 7919 % 0xffffff).toString(16).padStart(6, "0")}; margin: ${i % 16}px 0; }
  </style>
  <script>
    document.querySelector("#part-${i}").addEventListener("click", event => {
      const target = event.target.closest("li")
      if (target) console.log("clicked", ${i}, target.textContent.trim())
    })
  </script>
</section>
`

const unicodeBlock = (i: number) => `const greeting${i} = "こんにちは世界 ${i}" // 日本語のコメント
	const emoji${i} = ["😀", "👩🏽‍💻", "🇮🇳", "✨"] // emoji ${i}
	const mixed${i} = { नमस्ते: "दुनिया", مرحبا: "عالم", "é": "combining" }
		indented_with_tabs(${i}, \`template \${greeting${i}}\`)
`

// Right-to-left text as it shows up in real files: i18n resources,
// comments and strings in code, markdown, SQL, HTML, with numbers,
// punctuation, emoji, Hebrew points and Persian ZWNJ.
const rtlBlock = (i: number) => `// ${i}: رسائل الواجهة (Arabic UI strings) — النسخة ${i % 9}.${i % 10}
export const messages${i} = {
	"he": {"greeting": "שלום עולם!", "inbox": "יש לך ${i % 50} הודעות חדשות", "price": "המחיר: ₪${i % 300}.90"},
	"ar": {"greeting": "مرحبا بالعالم", "items": "لديك ${i % 20} عناصر في السلة", "date": "٢٠٢٤/٠٣/${(i % 28) + 1}"},
	"fa": {"title": "می‌خواهم ۱۲۳ کتاب بخرم", "ok": "تأیید"},
	"ur": "یہ ایک مثال ہے 👋",
}
function greet${i}(name) { return \`שלום \${name}, ברוך הבא (${i})\` } // ברכה למשתמש
const sql${i} = "SELECT * FROM users WHERE name = 'محمد' AND age > ${i % 60};"
	label${i}.textContent = "שלב " + (${i} + 1) + " מתוך 10"	// tab-separated
// בְּרֵאשִׁית בָּרָא אֱלֹהִים — ${i}
<p dir="rtl">مرحبا <b>بك</b> في الموقع رقم ${i}!</p>
## الفصل ${i % 12}: مقدمة (الجزء الأول) - Introduction

`

// Deeply nested code with long lines (like a promise chain deep inside
// callbacks): with wrapping on a phone, the continuation indent is
// capped at half the width, so wrapped rows start left of the outer
// indent guides, which must stop there (VS Code).
const deepBlock = (i: number) => {
	let out: string[] = [], depth = 16, pad = (d: number) => "  ".repeat(d)
	for (let d = 0; d < depth; d++) out.push(`${pad(d)}${d ? `level${d}(async (arg${d}) => {` : `export function deep${i}() {`}`)
	out.push(`${pad(depth)}return iap.getProducts([remotePlugin.sku, "item-${i}"]).then(([product]) => products[${i % 7}]);`,
		`${pad(depth)}if (isPaid && !purchaseToken) { throw new Error("Product not found: " + product.productId + " (${i})"); }`,
		`${pad(depth)}const purchaseToken = purchase?.purchaseToken ?? (await helpers.checkAPIStatus(${i}, {retry: true}));`,
		`${pad(depth)}return null;`)
	for (let d = depth - 1; d >= 0; d--) out.push(`${pad(d)}${d ? "})" : "}"}`)
	return out.join("\n") + "\n\n"
}

export type FixtureKind = "js" | "html" | "unicode" | "longline" | "rtl" | "deep"

export function makeFixture(kind: FixtureKind, lines: number): string {
	if (kind == "longline") {
		let parts: string[] = []
		for (let i = 0; i < lines; i++)
			parts.push(i % 50 == 0 ? `const data${i} = [${Array.from({length: 4000}, (_, k) => (k * 31 + i) % 1000).join(", ")}]` : `let x${i} = compute(${i}) // line ${i}`)
		return parts.join("\n")
	}
	let make = kind == "html" ? htmlBlock : kind == "unicode" ? unicodeBlock : kind == "rtl" ? rtlBlock : kind == "deep" ? deepBlock : jsBlock
	let out: string[] = [], count = 0
	for (let i = 0; count < lines; i++) {
		let block = make(i)
		out.push(block)
		count += block.split("\n").length - 1
	}
	return out.join("").split("\n").slice(0, lines).join("\n")
}
