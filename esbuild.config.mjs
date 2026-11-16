import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const tldraw = JSON.parse(readFileSync('node_modules/tldraw/package.json', 'utf8'))
await esbuild.build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	minify: true,
	format: 'cjs',
	target: 'es2022',
	platform: 'browser',
	external: ['obsidian', 'electron'],
	define: { TLDRAW_VERSION: JSON.stringify(tldraw.version), 'process.env.NODE_ENV': '"production"' },
	loader: { '.css': 'empty' },
	outfile: 'main.js',
})
