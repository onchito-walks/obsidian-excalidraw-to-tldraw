import esbuild from 'esbuild'

await esbuild.build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	minify: true,
	format: 'cjs',
	target: 'es2022',
	platform: 'browser',
	external: ['obsidian', 'electron'],
	banner: { js: '/* Excalidraw to tldraw. Bundles lz-string (c) 2013 Pieroxy, MIT licence, https://github.com/pieroxy/lz-string */' },
	outfile: 'main.js',
})
