// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import LZString from 'lz-string'
import * as tl from 'tldraw'
import { createTLSchema, parseTldrawJsonFile } from 'tldraw'
import { expect, test } from 'vitest'
import { TLDATA_END, TLDATA_START, convertScene, snapColor, toTldrawMarkdown } from './convert'
import { attachmentName, cellText, parseExcalidraw, safeFolder, targetPath } from './parse'

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
			el({ type: 'text', id: 'cap', text: 'cap', fontSize: 12, fontFamily: 3, textAlign: 'left', frameId: 'fr', x: 30, y: 40, width: 0 }),
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
	const diamond = shapes.find((s) => s.props.geo === 'diamond'), arrow = shapes.find((s) => s.type === 'arrow')
	expect([diamond.props.size, diamond.props.scale, arrow.props.size, arrow.props.scale, rect.props.size]).toEqual(['s', 1, 's', 1, 's']) // strokeWidth 2 is tldraw's s
	expect(records.filter((r) => r.typeName === 'asset')).toHaveLength(1)
	expect(records.find((r) => r.typeName === 'instance_page_state').selectedShapeIds).toEqual([])
})

test('white fills keep the outline colour and solid dark fills stay solid', async () => {
	const { file } = await convertScene(tl, {
		elements: [
			el({ type: 'rectangle', id: 'w', strokeColor: '#e03131', backgroundColor: '#fff', link: 'https://example.com/a?b=1' }),
			el({ type: 'ellipse', id: 'k', backgroundColor: 'black' }),
			el({ type: 'diamond', id: 'p', backgroundColor: '#ffc9c9' }),
			el({ type: 'ellipse', id: 'tint', strokeColor: '#1971c2', backgroundColor: '#a5d8ff', x: 500 }),
			el({ type: 'line', id: 'tri', backgroundColor: 'black', points: [[0, 0], [40, 0], [20, 30], [0, 0]] }),
			el({ type: 'line', id: 'open', points: [[0, 0], [40, 0], [20, 30]] }),
			el({ type: 'line', id: 'gap', backgroundColor: 'black', points: [[0, 0], [40, 0], [20, 30]] }), // ends apart: still filled
		],
	})
	const shapes = load(file).filter((r) => r.typeName === 'shape')
	const tri = shapes.find((r) => r.type === 'draw' && r.props.segments.length === 3) // record order is by random id
	expect(shapes.filter((r) => r.type === 'draw').map((r) => [r.props.isClosed, r.props.fill])).toEqual([[true, 'fill'], [true, 'fill']])
	expect([tri.props.isClosed, tri.props.fill, tri.props.color, tri.props.segments.length, tri.x, tri.y]).toEqual([true, 'fill', 'black', 3, shapes.find((r) => r.type === 'line').x, shapes.find((r) => r.type === 'line').y])
	const geo = Object.fromEntries(load(file).filter((r) => r.type === 'geo' && r.props.color !== 'blue').map((r) => [r.props.geo, r.props]))
	expect([geo.rectangle.fill, geo.rectangle.color, geo.rectangle.url]).toEqual(['semi', 'red', 'https://example.com/a?b=1'])
	expect([geo.ellipse.fill, geo.ellipse.color, geo.ellipse.url]).toEqual(['fill', 'black', ''])
	// Black outline, pink fill: tldraw has one colour per shape, so the fill goes underneath as a second shape.
	const [under, over] = shapes.filter((r) => r.props.geo === 'diamond').sort((a, b) => (a.index < b.index ? -1 : 1))
	expect([under.props.fill, under.props.color, over.props.fill, over.props.color]).toEqual(['solid', 'light-red', 'none', 'black'])
	expect([under.x, under.y, under.parentId]).toEqual([over.x, over.y, over.parentId])
	expect(shapes.find((r) => r.id === over.parentId).type).toBe('group')
	// A fill that is the outline's own tint needs only one shape.
	expect(shapes.filter((r) => r.props.color === 'blue').map((r) => r.props.fill)).toEqual(['solid'])
})

test('a lone member of a group moves with the drawing, and right-angle arrows become elbows', async () => {
	const { file } = await convertScene(tl, {
		elements: [
			el({ type: 'rectangle', id: 'a', x: 1000, y: 1000, groupIds: ['g'] }),
			el({ type: 'ellipse', id: 'b', x: 1200, y: 1000, groupIds: ['g'] }),
			el({ type: 'text', id: 't', text: 'x', fontSize: 20, fontFamily: 1, textAlign: 'left', x: 1100, y: 1100, groupIds: ['solo', 'g'], width: 0 }),
			el({ type: 'arrow', id: 'bent', x: 1000, y: 1300, points: [[0, 0], [-50, 0], [-50, -80]] }),
		],
	})
	const editorless = load(file).filter((r) => r.typeName === 'shape')
	const t = editorless.find((r) => r.type === 'text'), a = editorless.find((r) => r.props.geo === 'rectangle')
	expect(t.parentId).toBe(a.parentId) // same group
	expect([Math.round(t.x - a.x), Math.round(t.y - a.y)]).toEqual([100, 100])
	expect(editorless.find((r) => r.type === 'arrow').props.kind).toBe('elbow')
})

test('line weights are exact, and a label that would force a heavy outline becomes grouped text', async () => {
	const { file } = await convertScene(tl, {
		elements: [
			el({ type: 'rectangle', id: 'thin', strokeWidth: 1, boundElements: [{ id: 'lt', type: 'text' }] }),
			el({ type: 'text', id: 'lt', text: 'thin', fontSize: 20, fontFamily: 1, textAlign: 'center', containerId: 'thin', width: 0 }),
			el({ type: 'rectangle', id: 'bold', strokeWidth: 4, x: 300, boundElements: [{ id: 'lb', type: 'text' }] }),
			el({ type: 'text', id: 'lb', text: 'bold', fontSize: 20, fontFamily: 1, textAlign: 'center', containerId: 'bold', width: 0 }),
			el({ type: 'line', id: 'hair', strokeWidth: 1, roughness: 0, points: [[0, 0], [50, 0]] }),
			el({ type: 'freedraw', id: 'ink', strokeWidth: 1, points: [[0, 0], [5, 5], [9, 3]] }),
		],
	})
	const shapes = load(file).filter((r) => r.typeName === 'shape')
	const px = (r: any) => ({ s: 2, m: 3.5, l: 5, xl: 10 } as any)[r.props.size] * r.props.scale
	const [thin, bold] = shapes.filter((r) => r.type === 'geo').sort((a, b) => px(a) - px(b))
	const text = shapes.find((r) => r.type === 'text')
	expect([px(thin), thin.props.richText.content[0].content, text.parentId]).toEqual([1, undefined, thin.parentId])
	expect(shapes.find((r) => r.id === thin.parentId).type).toBe('group')
	expect(Math.abs(px(bold) - 4)).toBeLessThan(1) // label kept: nearest preset
	expect(JSON.stringify(bold.props.richText)).toContain('bold')
	const hair = shapes.find((r) => r.type === 'line')
	expect([px(hair), hair.props.dash]).toEqual([1, 'solid'])
	expect(px(shapes.find((r) => r.type === 'draw'))).toBeCloseTo(2.7)
})

test('a filled outline in a group of two stays in its group, in place', async () => {
	const { file } = await convertScene(tl, {
		elements: [
			el({ type: 'ellipse', id: 'head', x: 1000, y: 1000, groupIds: ['g'] }),
			el({ type: 'line', id: 'hat', x: 1010, y: 990, backgroundColor: '#4c6ef5', groupIds: ['g'], points: [[0, 0], [40, 0], [20, -30], [0, 0]] }),
			el({ type: 'rectangle', id: 'far', x: 0, y: 0 }),
		],
	})
	const shapes = load(file).filter((r) => r.typeName === 'shape')
	const hat = shapes.find((r) => r.type === 'draw'), head = shapes.find((r) => r.props.geo === 'ellipse')
	expect(hat.parentId).toBe(head.parentId)
	expect(shapes.find((r) => r.id === hat.parentId).type).toBe('group')
	expect([Math.round(hat.x - head.x), Math.round(hat.y - head.y)]).toEqual([10, -10])
})

const demos = ['demo/Flowchart', 'demo/Sketchnote', 'demo/public/Stick figures', 'demo/public/UML activity', 'demo/public/Wireframe kit']
test.each(demos)('%s keeps its layout: every shape sits where its element was', async (name: string) => {
	const { scene } = parseExcalidraw(readFileSync(join(__dirname, '..', name + '.excalidraw'), 'utf8'))
	const { file } = await convertScene(tl, scene)
	const shapes = load(file).filter((r) => r.typeName === 'shape')
	const by = new Map(shapes.map((r) => [r.id, r]))
	const page = (r: any): number[] => { const p = by.get(r.parentId); if (!p) return [r.x, r.y]; const q = page(p); return [q[0] + r.x, q[1] + r.y] }
	const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`
	// Rotated shapes pivot differently and labels fold into their shapes: compare the rest.
	const src = scene.elements.filter((e: any) => !e.isDeleted && !e.angle && !e.containerId && e.type !== 'text')
	const out = shapes.filter((r) => !r.rotation && r.type !== 'group' && r.type !== 'text')
	const [ox, oy] = [Math.min(...out.map((r) => page(r)[0])), Math.min(...out.map((r) => page(r)[1]))]
	const [sx, sy] = [Math.min(...src.map((e: any) => e.x)), Math.min(...src.map((e: any) => e.y))]
	const want = new Set(src.map((e: any) => key(e.x - sx, e.y - sy)))
	const got = new Set(out.map((r) => key(page(r)[0] - ox, page(r)[1] - oy)))
	const near = (set: Set<string>, k: string) => { const [x, y] = k.split(',').map(Number); return [-1, 0, 1].some((a) => [-1, 0, 1].some((b) => set.has(`${x + a},${y + b}`))) }
	expect([...got].filter((k) => !near(want, k))).toEqual([])
	expect([...want].filter((k) => !near(got, k))).toEqual([])
})

test('a rounded filled outline stays curved', async () => {
	const { file } = await convertScene(tl, {
		elements: [el({ type: 'line', id: 'blob', backgroundColor: 'black', roundness: { type: 2 }, points: [[0, 0], [40, -30], [80, 0], [40, 30], [0, 0]] })],
	})
	const blob = load(file).find((r) => r.type === 'draw')
	const pts = blob.props.segments.map((s: any) => tl.b64Vecs.decodePoints(s.path)[1])
	expect(pts).toHaveLength(32) // 4 spans, 8 steps each
	expect([pts[3].x, pts[3].y]).toEqual([15, -18.75]) // halfway along the first side: off the straight chord (20, -15)
	expect([Math.round(pts.at(-1).x), Math.round(pts.at(-1).y)]).toEqual([0, 0])
})

test('a link that is not a web or mail address is dropped, not carried into the drawing', async () => {
	const { file, converted } = await convertScene(tl, {
		elements: [
			el({ type: 'rectangle', id: 'bad', link: 'javascript:alert(1)' }),
			el({ type: 'ellipse', id: 'vault', link: '[[Some note]]' }),
			el({ type: 'diamond', id: 'good', link: 'https://example.com/' }),
		],
	})
	expect(converted).toBe(3)
	expect(load(file).filter((r) => r.type === 'geo').map((r) => r.props.url).sort()).toEqual(['', '', 'https://example.com/'])
})

test('an image id from a file cannot steer where its attachment is written', () => {
	expect(attachmentName('notes/Sketch.tldraw.md', '../../../evil/x', 'png')).toBe('Sketch-evilx.png')
	expect(attachmentName('Sketch.tldraw.md', 'abc123def456', 'png')).toBe('Sketch-abc123de.png')
	expect(attachmentName('Sketch.tldraw.md', '///', 'png')).toBe('Sketch-image.png')
	const md = obsidianMd('```json\n{"elements":[]}\n```', '## Embedded Files\n__proto__: [[x.png]]\nconstructor: [[y.png]]\n\n')
	expect(Object.keys(parseExcalidraw(md).embedded)).toEqual(['__proto__', 'constructor'])
	expect(({} as any).x).toBeUndefined()
})

test('an empty scene converts to nothing', async () => {
	const { converted, skipped } = await convertScene(tl, { elements: [el({ type: 'text', isDeleted: true })] })
	expect([converted, skipped]).toEqual([0, {}])
})

test('text from a drawing cannot break or inject into the report table', () => {
	const t = cellText('a|b\n| x | [[Secret]]')
	expect(t).toBe('a/b / x / Secret')
})

test('converted drawings go next to the original, or mirror the folder layout into a chosen folder', () => {
	expect(targetPath('a/b/Sketch.excalidraw.md')).toBe('a/b/Sketch.tldraw.md')
	expect(targetPath('a/Plain.excalidraw')).toBe('a/Plain.tldraw.md')
	expect(targetPath('a/b/Sketch.excalidraw.md', 'out')).toBe('out/a/b/Sketch.tldraw.md')
	expect(targetPath('a/b/Sketch.excalidraw.md', 'out', 'a')).toBe('out/b/Sketch.tldraw.md')
	expect(targetPath('Top.excalidraw.md', 'out/x/', '')).toBe('out/x/Top.tldraw.md')
})

test('a destination folder cannot leave the vault', () => {
	expect(safeFolder(' /out/sub/ ')).toBe('out/sub')
	expect(safeFolder('')).toBe('')
	for (const bad of ['../x', 'a/../b', 'a/./b', 'C:\\x', 'a|b', 'a/<b>']) expect(safeFolder(bad)).toBeNull()
})
