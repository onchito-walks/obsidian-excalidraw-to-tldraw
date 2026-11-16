/// <reference types="wdio-obsidian-service" />
import LZString from 'lz-string'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const root = path.dirname(fileURLToPath(import.meta.url))
const vault = path.join(root, '.wdio', 'vault')
const plugin = path.join(root, '.wdio', 'plugin')

const base = {
	angle: 0, opacity: 100, groupIds: [], locked: false, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
	fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, isDeleted: false, link: null, boundElements: null,
}
const elements = [
	{ ...base, id: 'box', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, backgroundColor: '#ffc9c9', strokeColor: '#e03131', boundElements: [{ type: 'text', id: 'label' }] },
	{ ...base, id: 'label', type: 'text', x: 60, y: 40, width: 80, height: 25, containerId: 'box', text: 'Converted', fontSize: 20, fontFamily: 1, textAlign: 'center' },
	{ ...base, id: 'oval', type: 'ellipse', x: 400, y: 0, width: 160, height: 100, strokeColor: '#1971c2' },
	{ ...base, id: 'arrow', type: 'arrow', x: 200, y: 50, width: 200, height: 0, points: [[0, 0], [200, 0]], endArrowhead: 'arrow', startBinding: { elementId: 'box' }, endBinding: { elementId: 'oval' } },
	{ ...base, id: 'ink', type: 'freedraw', x: 0, y: 160, width: 300, height: 40, strokeWidth: 0.5, points: Array.from({ length: 60 }, (_, i) => [i * 5, 20 * Math.sin(i / 4)]) },
	{ ...base, id: 'note', type: 'text', x: 0, y: 240, width: 200, height: 25, text: 'free text', fontSize: 20, fontFamily: 1, textAlign: 'left' },
	{ ...base, id: 'photo', type: 'image', x: 400, y: 160, width: 120, height: 120, fileId: 'pic' },
	{ ...base, id: 'frame', type: 'frame', x: -20, y: -20, width: 620, height: 320 },
]
const chunk = (type: string, data: Buffer) => {
	const body = Buffer.concat([Buffer.from(type), data])
	const out = Buffer.alloc(body.length + 8)
	out.writeUInt32BE(data.length, 0)
	body.copy(out, 4)
	out.writeUInt32BE(crc32(body), body.length + 4)
	return out
}
// 8×8 solid green PNG
const png = Buffer.concat([
	Buffer.from('89504e470d0a1a0a', 'hex'),
	chunk('IHDR', Buffer.from('000000080000000808020000' + '00', 'hex')),
	chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => Buffer.from('00' + '2f9e44'.repeat(8), 'hex'))))),
	chunk('IEND', Buffer.alloc(0)),
])
const md = (json: string, embedded = '') =>
	`---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n# Excalidraw Data\n## Text Elements\n${embedded}%%\n## Drawing\n\`\`\`compressed-json\n${LZString.compressToBase64(json).match(/.{1,256}/g)!.join('\n\n')}\n\`\`\`\n%%`

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./e2e/*.e2e.ts'],
	maxInstances: 1,
	capabilities: [
		{
			browserName: 'obsidian',
			browserVersion: 'latest',
			'wdio:obsidianOptions': {
				installerVersion: 'latest',
				plugins: [{ id: 'tldraw', version: '1.35.1' }, plugin],
				vault,
			},
		},
	],
	services: ['obsidian'],
	reporters: ['obsidian'],
	cacheDir: path.join(root, '.wdio', 'cache'),
	mochaOpts: { ui: 'bdd', timeout: 120000 },
	onPrepare() {
		rmSync(vault, { recursive: true, force: true })
		mkdirSync(path.join(vault, 'sub', 'img'), { recursive: true })
		mkdirSync(plugin, { recursive: true })
		for (const f of ['main.js', 'manifest.json']) copyFileSync(path.join(root, f), path.join(plugin, f))
		// A plain .excalidraw carries its image inline; the Obsidian flavour links to a vault file.
		writeFileSync(
			path.join(vault, 'Diagram.excalidraw'),
			JSON.stringify({ type: 'excalidraw', elements, files: { pic: { mimeType: 'image/png', dataURL: `data:image/png;base64,${png.toString('base64')}` } } })
		)
		writeFileSync(path.join(vault, 'sub', 'img', 'pixel.png'), png)
		writeFileSync(
			path.join(vault, 'sub', 'Sketch.excalidraw.md'),
			md(JSON.stringify({ type: 'excalidraw', elements, files: {} }), '## Embedded Files\npic: [[pixel.png]]\n\n')
		)
		writeFileSync(path.join(vault, 'Empty.excalidraw.md'), md(JSON.stringify({ type: 'excalidraw', elements: [], files: {} })))
		writeFileSync(path.join(vault, 'Note.md'), 'An ordinary note.\n')
	},
}
