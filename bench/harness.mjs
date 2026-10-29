// Shared helpers for the benchmark and browser-test scripts: a static
// server for demo-dist and a Chromium launcher.
import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {extname, join, resolve} from "node:path"
import puppeteer from "puppeteer-core"
import {chromium} from "playwright"

const types = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}

export function parseArgs(argv = process.argv.slice(2)) {
	return Object.fromEntries(argv.map(a => {
		// Only the first "=" separates: values hold more (--query=wrap=1&ext=full).
		let arg = a.replace(/^--/, ""), eq = arg.indexOf("=")
		return eq < 0 ? [arg, "true"] : [arg.slice(0, eq), arg.slice(eq + 1)]
	}))
}

export async function serveDemo(port = 0) {
	let root = resolve(import.meta.dirname, "../demo-dist")
	let server = createServer(async (req, res) => {
		let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))
		if (path.endsWith("/")) path += "index.html"
		let body
		try { body = await readFile(path) } catch {
			res.writeHead(404)
			res.end()
			return
		}
		res.writeHead(200, {"content-type": types[extname(path)] ?? "application/octet-stream"})
		res.end(body)
	}).listen(port)
	await new Promise(r => server.once("listening", r))
	return {url: `http://localhost:${server.address().port}`, close: () => server.close()}
}

/// Playwright's Chrome for Testing, pinned by the playwright devDependency
/// (`bunx playwright install chromium`).
export const defaultBrowser = chromium.executablePath()

/// `CHROME_ARGS` adds flags, e.g. CI's software GPU (SwiftShader) on a
/// machine without one.
export function launch(args = {}) {
	return puppeteer.launch({
		executablePath: args.browser ?? process.env.CHROME_PATH ?? defaultBrowser,
		headless: args.headful ? false : true,
		args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--no-first-run",
			...(process.env.CHROME_ARGS ?? "").split(/\s+/).filter(Boolean)]
	})
}

/// A phone-sized page with touch.
export async function phonePage(browser) {
	let page = await browser.newPage()
	await page.emulate({
		viewport: {width: 412, height: 860, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true},
		userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36"
	})
	return page
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
