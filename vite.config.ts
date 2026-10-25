import {resolve} from "node:path"
import {defineConfig} from "vite"

export default defineConfig({
	root: resolve(import.meta.dirname, "demo"),
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "demo-dist"),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				index: resolve(import.meta.dirname, "demo/index.html"),
				cm: resolve(import.meta.dirname, "demo/cm.html"),
				ace: resolve(import.meta.dirname, "demo/ace.html"),
				monaco: resolve(import.meta.dirname, "demo/monaco.html")
			}
		}
	}
})
