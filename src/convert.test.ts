// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import LZString from 'lz-string'
import * as tl from 'tldraw'
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
	// Excalidraw plugin 1.x wrote single-# headings and "Embedded files".
	const old = `---\nexcalidraw-plugin: parsed\n---\n# Text Elements\r\n\r\n# Embedded files\r\nabc: [[Pasted Image 1.jpg]]\r\n\r\n%%\r\n# Drawing\r\n\`\`\`json\r\n${json}\r\n\`\`\`\r\n%%`
	expect(parseExcalidraw(old).embedded).toEqual({ abc: '[[Pasted Image 1.jpg]]' })
	expect(() => parseExcalidraw('# just a note')).toThrow()
})

test('snaps custom colours to the nearest colour tldraw knows', () => {
	expect(snapColor('#ff0000')).toBe('#e03131')
	expect(snapColor('#1e1e1e')).toBe('#343a40') // dark grey: tldraw maps it to black
	expect(snapColor('#00F')).toBe('#1971c2')
	expect(snapColor('transparent')).toBe('transparent')
	expect(snapColor('white')).toBe('#ffffff')
})

const fixtures = join(__dirname, '../node_modules/tldraw/src/lib/utils/excalidraw/excalidraw-test-fixtures')
test.each(readdirSync(fixtures))('tldraw loads its own fixture %s after conversion', async (name: string) => {
	const scene = JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
	const { file, converted, skipped } = await convertScene(tl, scene)
	expect(skipped).toEqual({})
	expect(converted).toBeGreaterThan(0)
	expect(load(file).filter((r) => r.typeName === 'shape').length).toBeGreaterThanOrEqual(converted)
})

test('converts a messy scene, reports what it left behind, and round-trips the plugin markdown', async () => {
	const box = el({ type: 'rectangle', id: 'box', strokeColor: '#ff0000', boundElements: [{ type: 'text', id: 'label' }] })
	const { file, converted, skipped } = await convertScene(tl, {
		elements: [
			box,
			el({ type: 'text', id: 'label', containerId: 'box', text: 'hi', fontSize: 20, fontFamily: 1, textAlign: 'center' }),
			el({ type: 'ellipse', isDeleted: true }),
			el({ type: 'freedraw', points: [[0, 0], [5, 5], [9, 3]], strokeWidth: 0.5 }),
			el({ type: 'freedraw', points: [] }),
			el({ type: 'arrow', points: [[0, 0], [50, 0]], endArrowhead: 'arrow', endBinding: { elementId: 'box' } }),
			el({ type: 'diamond', angle: 1 }),
			el({ type: 'frame', id: 'fr', name: 'Board', x: 0, y: 0, width: 400, height: 300 }),
			el({ type: 'text', id: 'cap', text: 'cap', fontSize: 12, fontFamily: 3, textAlign: 'left', frameId: 'fr', x: 30, y: 40 }),
			el({ type: 'image', fileId: 'gone' }),
			el({ type: 'image', fileId: 'pic' }),
		],
		files: { pic: { mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=' } },
	})
	expect(skipped).toEqual({ 'image (source not found)': 1, 'freedraw (no points)': 1 })
	expect(converted).toBe(7) // rectangle+label, freedraw, arrow, diamond, image, frame, caption

	const md = toTldrawMarkdown(file, '1.35.1', '5.6.0')
	expect(md.startsWith('---\ntldraw-file: true\n---\n')).toBe(true)
	const data = JSON.parse(md.slice(md.indexOf(TLDATA_START) + TLDATA_START.length, md.indexOf(TLDATA_END)))
	expect(data.meta['tldraw-version']).toBe('5.6.0')

	const records = load(data.raw)
	const shapes = records.filter((r) => r.typeName === 'shape')
	expect(shapes.map((s) => s.type).sort()).toEqual(['arrow', 'draw', 'frame', 'geo', 'geo', 'image', 'text'])
	const rect = shapes.find((s) => s.props.geo === 'rectangle')
	expect(rect.props.color).toBe('red')
	expect(JSON.stringify(rect.props.richText)).toContain('hi')
	expect(shapes.find((s) => s.props.geo === 'diamond').rotation).toBeCloseTo(1)
	expect(records.filter((r) => r.typeName === 'binding')).toHaveLength(1)
	const cap = shapes.find((s) => s.type === 'text'), frame = shapes.find((s) => s.type === 'frame')
	expect([cap.props.size, cap.props.scale, cap.props.font, cap.parentId]).toEqual(['m', 0.5, 'mono', frame.id])
	expect([cap.x, cap.y, frame.props.name]).toEqual([30, 40, 'Board']) // position inside the frame is kept
	expect(shapes.find((s) => s.type === 'draw').props.size).toBe('s')
	expect(records.filter((r) => r.typeName === 'asset')).toHaveLength(1)
	expect(records.find((r) => r.typeName === 'instance_page_state').selectedShapeIds).toEqual([])
})

test('white fills keep the outline colour and solid dark fills stay solid', async () => {
	const { file } = await convertScene(tl, {
		elements: [
			el({ type: 'rectangle', id: 'w', strokeColor: '#e03131', backgroundColor: '#fff', link: 'https://example.com/a?b=1' }),
			el({ type: 'ellipse', id: 'k', backgroundColor: 'black' }),
			el({ type: 'diamond', id: 'p', backgroundColor: '#ffc9c9' }),
		],
	})
	const geo = Object.fromEntries(load(file).filter((r) => r.type === 'geo').map((r) => [r.props.geo, r.props]))
	expect([geo.rectangle.fill, geo.rectangle.color, geo.rectangle.url]).toEqual(['semi', 'red', 'https://example.com/a?b=1'])
	expect([geo.ellipse.fill, geo.ellipse.color, geo.ellipse.url]).toEqual(['fill', 'black', ''])
	expect([geo.diamond.fill, geo.diamond.color]).toEqual(['solid', 'light-red'])
})

test('an empty scene converts to nothing', async () => {
	const { converted, skipped } = await convertScene(tl, { elements: [el({ type: 'text', isDeleted: true })] })
	expect([converted, skipped]).toEqual([0, {}])
})
