// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import LZString from 'lz-string'
import { createTLSchema, parseTldrawJsonFile } from 'tldraw'
import { expect, test } from 'vitest'
import { TLDATA_END, TLDATA_START, convertScene, snapColor, toTldrawMarkdown } from './convert'
import { parseExcalidraw } from './parse'

const el = (o: Record<string, unknown>) => ({
	id: `el-${o.type}-${Math.random()}`,
	x: 10, y: 20, width: 100, height: 50, angle: 0, opacity: 100, groupIds: [], locked: false,
	strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
	strokeStyle: 'solid', roughness: 1, isDeleted: false, link: null,
	...o,
}) // boundElements deliberately absent: old files omit it

/** What the tldraw plugin does on open: tldraw's own parser + validator + migrations. */
function load(file: unknown) {
	const r = parseTldrawJsonFile({ json: JSON.stringify(file), schema: createTLSchema() })
	if (!r.ok) throw new Error(JSON.stringify(r.error))
	return r.value.allRecords() as any[]
}

const obsidianMd = (block: string, extra = '') =>
	`---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==⚠  Switch to EXCALIDRAW VIEW ⚠==\n\n# Excalidraw Data\n## Text Elements\nhello ^abc123\n\n${extra}%%\n## Drawing\n${block}\n%%`

test('parses plain, json-block and compressed Obsidian files', () => {
	const scene = { type: 'excalidraw', elements: [el({ type: 'rectangle' })] }
	const json = JSON.stringify(scene)
	// The Excalidraw plugin wraps the base64 in short lines separated by blank lines.
	const wrapped = LZString.compressToBase64(json).match(/.{1,64}/g)!.join('\n\n')
	const embedded = '## Embedded Files\nabc123def: [[img/photo.png|100]]\nfff000: $$x^2$$\n\n'

	expect(parseExcalidraw(json).scene.elements).toHaveLength(1)
	expect(parseExcalidraw(obsidianMd('```json\n' + json + '\n```')).scene.elements).toHaveLength(1)
	const parsed = parseExcalidraw(obsidianMd('```compressed-json\n' + wrapped + '\n```', embedded))
	expect(parsed.scene.elements[0].type).toBe('rectangle')
	expect(parsed.embedded).toEqual({ abc123def: '[[img/photo.png|100]]', fff000: '$$x^2$$' })
	expect(() => parseExcalidraw('# just a note')).toThrow()
})

test('snaps custom colours to the nearest colour tldraw knows', () => {
	expect(snapColor('#ff0000')).toBe('#e03131')
	expect(snapColor('#1e1e1e')).toBe('#343a40') // dark grey: tldraw maps it to black
	expect(snapColor('#00F')).toBe('#1971c2')
	expect(snapColor('transparent')).toBe('transparent')
})

const fixtures = join(__dirname, '../node_modules/tldraw/src/lib/utils/excalidraw/excalidraw-test-fixtures')
test.each(readdirSync(fixtures))('tldraw loads its own fixture %s after conversion', async (name: string) => {
	const scene = JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
	const { file, converted, skipped } = await convertScene(scene)
	expect(skipped).toEqual({})
	expect(converted).toBeGreaterThan(0)
	expect(load(file).filter((r) => r.typeName === 'shape').length).toBeGreaterThanOrEqual(converted)
})

test('converts a messy scene, reports what it left behind, and round-trips the plugin markdown', async () => {
	const box = el({ type: 'rectangle', id: 'box', strokeColor: '#ff0000', boundElements: [{ type: 'text', id: 'label' }] })
	const { file, converted, skipped } = await convertScene({
		elements: [
			box,
			el({ type: 'text', id: 'label', containerId: 'box', text: 'hi', fontSize: 20, fontFamily: 1, textAlign: 'center' }),
			el({ type: 'ellipse', isDeleted: true }),
			el({ type: 'freedraw', points: [[0, 0], [5, 5], [9, 3]], strokeWidth: 0.5 }),
			el({ type: 'freedraw', points: [] }),
			el({ type: 'arrow', points: [[0, 0], [50, 0]], endArrowhead: 'arrow', endBinding: { elementId: 'box' } }),
			el({ type: 'diamond', angle: 1 }),
			el({ type: 'frame' }),
			el({ type: 'image', fileId: 'gone' }),
			el({ type: 'image', fileId: 'pic' }),
		],
		files: { pic: { mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=' } },
	})
	expect(skipped).toEqual({ frame: 1, 'image (source not found)': 1, 'freedraw (no points)': 1 })
	expect(converted).toBe(5) // rectangle+label, freedraw, arrow, diamond, image

	const md = toTldrawMarkdown(file, '1.35.1', '5.6.0')
	expect(md.startsWith('---\ntldraw-file: true\n---\n')).toBe(true)
	const data = JSON.parse(md.slice(md.indexOf(TLDATA_START) + TLDATA_START.length, md.indexOf(TLDATA_END)))
	expect(data.meta['tldraw-version']).toBe('5.6.0')

	const records = load(data.raw)
	const shapes = records.filter((r) => r.typeName === 'shape')
	expect(shapes.map((s) => s.type).sort()).toEqual(['arrow', 'draw', 'geo', 'geo', 'image'])
	const rect = shapes.find((s) => s.props.geo === 'rectangle')
	expect(rect.props.color).toBe('red')
	expect(JSON.stringify(rect.props.richText)).toContain('hi')
	expect(shapes.find((s) => s.props.geo === 'diamond').rotation).toBeCloseTo(1)
	expect(records.filter((r) => r.typeName === 'binding')).toHaveLength(1)
	expect(records.filter((r) => r.typeName === 'asset')).toHaveLength(1)
	expect(records.find((r) => r.typeName === 'instance_page_state').selectedShapeIds).toEqual([])
})

test('an empty scene converts to nothing', async () => {
	const { converted, skipped } = await convertScene({ elements: [el({ type: 'text', isDeleted: true })] })
	expect([converted, skipped]).toEqual([0, {}])
})
