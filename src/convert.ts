import type { TldrawFile } from 'tldraw'

/** The tldraw module. The plugin takes it from the installed tldraw plugin instead of bundling its own. */
export type Tldraw = typeof import('tldraw')

export interface Conversion {
	file: TldrawFile
	converted: number
	/** What was left behind, by reason. */
	skipped: Record<string, number>
}

// The Open Color hexes tldraw's Excalidraw importer recognises; anything else it paints black.
const KNOWN = `f8f9fa e9ecef ced4da 868e96 343a40 fff5f5 ffc9c9 ff8787 fa5252 e03131
fff0f6 fcc2d7 f783ac e64980 c2255c f8f0fc eebefa da77f2 be4bdb 9c36b5
e7f5ff a5d8ff 4dabf7 228be6 1971c2 e3fafc 99e9f2 3bc9db 15aabf 0c8599
e6fcf5 96f2d7 38d9a9 12b886 099268 ebfbee b2f2bb 69db7c 40c057 2f9e44
fff9db ffec99 ffd43b fab005 f08c00 fff4e6 ffd8a8 ffa94d fd7e14 e8590c
ffffff 000000`.split(/\s+/)

const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** Snaps any hex colour to the nearest one the importer knows, so custom colours keep their hue. */
export function snapColor(color: unknown): unknown {
	if (typeof color !== 'string') return color
	let hex = ({ black: '000000', white: 'ffffff' } as Record<string, string>)[color.toLowerCase()] ?? color.replace('#', '').toLowerCase()
	if (/^[0-9a-f]{3}$/.test(hex)) hex = hex.replace(/./g, '$&$&')
	if (!/^[0-9a-f]{6}/.test(hex)) return color // 'transparent', named colours: importer decides
	const [r, g, b] = rgb(hex)
	let best = KNOWN[0]
	let bestD = Infinity
	for (const k of KNOWN) {
		const [kr, kg, kb] = rgb(k)
		const d = (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2
		if (d < bestD) [best, bestD] = [k, d]
	}
	return '#' + best
}

const GEO = new Set(['rectangle', 'ellipse', 'diamond'])
// Excalidraw font ids: Virgil, Helvetica, Cascadia, (4 unused), Excalifont, Nunito, Lilita One, Comic Shanns.
const FONTS: Record<number, string> = { 1: 'draw', 2: 'sans', 3: 'mono', 5: 'draw', 6: 'sans', 7: 'sans', 8: 'mono' }
const WHITE = new Set(['#ffffff', '#f8f9fa'])
const DARK = new Set(KNOWN.flatMap((k, i) => (i < 50 && i % 5 > 2 ? ['#' + k] : [])).concat('#000000'))

const PAIRS = [['grey', 'black'], ['light-red', 'red'], ['light-red', 'red'], ['light-violet', 'violet'], ['light-blue', 'blue'], ['light-blue', 'blue'], ['light-green', 'green'], ['light-green', 'green'], ['yellow', 'orange'], ['yellow', 'orange']]

/** tldraw's colour for a snapped hex, as its importer maps them. */
function colorName(hex: string) {
	const i = KNOWN.indexOf(hex.slice(1))
	if (i >= 50 || i < 0) return i === 50 ? 'white' : 'black'
	const [light, dark] = PAIRS[Math.floor(i / 5)]
	return i % 5 < 3 ? light : dark
}

// What tldraw draws, in px at scale 1: line weight and label text size per size preset.
const STROKE: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
const LABEL: Record<string, number> = { s: 18, m: 22, l: 26, xl: 32 }
const width = (e: any) => (Number.isFinite(e.strokeWidth) && e.strokeWidth > 0 ? e.strokeWidth : 1)

/** A smooth (Catmull-Rom) curve through the points, as short straight steps: how Excalidraw draws a rounded line. */
function curve(p: number[][], steps = 8) {
	const loop = Math.hypot(p[0][0] - p.at(-1)![0], p[0][1] - p.at(-1)![1]) < 2
	const n = p.length - 1
	const at = (i: number) => (loop ? p[((i % n) + n) % n] : p[Math.max(0, Math.min(n, i))])
	const out = [p[0]]
	for (let i = 0; i < n; i++)
		for (let s = 1; s <= steps; s++) {
			const t = s / steps
			out.push([0, 1].map((k) => 0.5 * (2 * at(i)[k] + (at(i + 1)[k] - at(i - 1)[k]) * t + (2 * at(i - 1)[k] - 5 * at(i)[k] + 4 * at(i + 1)[k] - at(i + 2)[k]) * t * t + (3 * at(i)[k] - at(i - 1)[k] - 3 * at(i + 1)[k] + at(i + 2)[k]) * t ** 3)))
		}
	return out
}

const SUPPORTED = new Set(['rectangle', 'ellipse', 'diamond', 'freedraw', 'line', 'arrow', 'text', 'image'])

/**
 * Converts an Excalidraw scene with tldraw's own importer (the code behind pasting Excalidraw
 * into tldraw), run on a headless editor, so the records are exactly what tldraw itself writes.
 */
export async function convertScene(
	tl: Tldraw,
	scene: { elements: any[]; files?: Record<string, any> }
): Promise<Conversion> {
	const skipped: Record<string, number> = {}
	const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1)
	const files = scene.files ?? {}

	const frames = scene.elements.filter((e) => e.type === 'frame' && !e.isDeleted)
	// The importer trusts its input: drop what would crash it or silently vanish, and say so.
	const elements = scene.elements
		.filter((e) => {
			if (e.isDeleted || e.type === 'frame') return false
			if (!SUPPORTED.has(e.type)) return skip(e.type), false
			if (e.type === 'image' && !files[e.fileId]?.dataURL) return skip('image (source not found)'), false
			const minPoints = e.type === 'freedraw' ? 1 : 2
			if ('freedraw line arrow'.includes(e.type) && !(e.points?.length >= minPoints))
				return skip(`${e.type} (no points)`), false
			return true
		})
		.map((e) => {
			const strokeColor = snapColor(e.strokeColor)
			const backgroundColor = snapColor(e.backgroundColor)
			// The importer gives a filled shape one colour, the fill's, shown as a pale tint. Excalidraw's two
			// commonest fills need better: white keeps the outline colour, a solid dark fill stays solid.
			// Excalidraw fills a line's outline whether or not its ends meet.
			const closed = e.type === 'line' && e.points?.length > 2 && backgroundColor !== 'transparent'
			const fill = !GEO.has(e.type) && !closed ? '' : WHITE.has(backgroundColor as string) ? 'semi' : e.fillStyle === 'solid' && DARK.has(backgroundColor as string) ? 'fill' : ''
			// A multi-point arrow whose legs are all horizontal or vertical is an elbow arrow, not a curve.
			const elbowed = e.elbowed || (e.type === 'arrow' && e.points.length > 2 && e.points.slice(1).every((p: number[], k: number) => Math.abs(p[0] - e.points[k][0]) < 1 || Math.abs(p[1] - e.points[k][1]) < 1))
			return { ...e, elbowed, closed, boundElements: e.boundElements ?? null, angle: e.angle ?? 0, strokeColor, backgroundColor: fill === 'semi' ? strokeColor : backgroundColor, fill }
		})
	// The importer groups by an element's innermost group and never moves the lone member of a group with
	// the rest of the drawing: drop group ids that have a single member here, so such elements stay in place.
	for (let again = true; again; ) {
		const count = new Map<string, number>()
		for (const e of elements) if (e.groupIds?.[0]) count.set(e.groupIds[0], (count.get(e.groupIds[0]) ?? 0) + 1)
		again = false
		for (const e of elements) if (e.groupIds?.[0] && count.get(e.groupIds[0]) === 1) (e.groupIds = e.groupIds.slice(1)), (again = true)
	}

	// A label shares its shape's scale, so its size fixes the line weight to one of four presets. When none
	// is within a quarter of the real weight, the label becomes its own text, grouped with the shape.
	const byId = new Map(elements.map((e) => [e.id, e]))
	for (const e of elements) {
		const label = GEO.has(e.type) && e.boundElements?.map((b: any) => byId.get(b.id)).find((b: any) => b?.type === 'text')
		if (!label) continue
		const font = label.fontSize || 20
		const weight = (p: string) => (STROKE[p] * font) / LABEL[p]
		e.preset = Object.keys(STROKE).reduce((a, b) => (Math.abs(weight(b) - width(e)) < Math.abs(weight(a) - width(e)) ? b : a))
		if (Math.abs(weight(e.preset) - width(e)) / width(e) <= 0.25) continue
		e.boundElements = e.boundElements.filter((b: any) => b.id !== label.id)
		if (!e.groupIds?.length) e.groupIds = [`label-${e.id}`]
		Object.assign(label, { containerId: null, groupIds: e.groupIds })
	}

	const container = document.createElement('div')
	const editor = new tl.Editor({
		store: tl.createTLStore({ shapeUtils: tl.defaultShapeUtils, bindingUtils: tl.defaultBindingUtils }),
		shapeUtils: tl.defaultShapeUtils,
		bindingUtils: tl.defaultBindingUtils,
		tools: [],
		getContainer: () => container,
		textOptions: { tipTapConfig: { extensions: tl.tipTapDefaultExtensions }, addFontsFromNode: tl.defaultAddFontsFromNode },
	})
	try {
		// Smaller than a typical window, so the saved zoom leaves room for tldraw's side panel and toolbar.
		editor.updateViewportScreenBounds(new tl.Box(0, 0, 1280, 720))
		if (elements.length) {
			// The importer mints one shape id per element, in order, before anything else: record them so each
			// element can be matched to its shape afterwards.
			const ids: string[] = []
			// (An internal tldraw hook: if a tldraw build lacks it, the drawing still converts, without the touch-ups below.)
			const { mockUniqueId, restoreUniqueId } = tl as any
			const hook = mockUniqueId && restoreUniqueId
			if (hook) mockUniqueId(() => (ids.push(crypto.randomUUID().replace(/-/g, '').slice(0, 21)), ids[ids.length - 1]))
			try {
				await tl.putExcalidrawContent(editor, { elements, files })
			} finally {
				if (hook) restoreUniqueId()
			}
			const shapeOf = (i: number) => editor.getShape(`shape:${ids[i]}` as any) as any
			const fixes: any[] = []
			elements.forEach((e, i) => {
				const sh = shapeOf(i)
				if (!sh) return // a label: the importer folds it into its container
				const props: Record<string, unknown> = {}
				if (e.fill && sh.type === 'geo') props.fill = e.fill
				if (sh.type === 'text') Object.assign(props, { size: 'm', scale: (e.fontSize || 20) / 24, font: FONTS[e.fontFamily] ?? 'draw' }) // m is 24px: exact size
				const label = e.boundElements?.map((b: any) => byId.get(b.id)).find((b: any) => b?.type === 'text')
				// Exact line weight: scale multiplies a preset's weight. It also sizes a label, so a labelled shape is
				// scaled for its text, on the preset whose weight then lands nearest (arrows: s, 18px labels).
				if (sh.type === 'geo' || sh.type === 'line' || sh.type === 'arrow') {
					if (label) Object.assign(props, { size: e.preset ?? 's', scale: (label.fontSize || 20) / LABEL[e.preset ?? 's'] })
					else Object.assign(props, { size: 's', scale: width(e) / STROKE.s })
				}
				// shortcut: freehand weight is one measured factor (2.7px of tldraw weight per Excalidraw unit); the two apps taper
				// strokes differently, so fast sparse strokes come out a little light and dense ones a little heavy.
				if (sh.type === 'draw') Object.assign(props, { size: 'm', scale: (width(e) * 2.7) / STROKE.m })
				// Excalidraw's 'architect' sloppiness is a clean line; tldraw's default is hand-drawn.
				if (e.roughness === 0 && sh.props.dash === 'draw') props.dash = 'solid'
				if (label && 'font' in sh.props) {
					props.font = FONTS[label.fontFamily] ?? 'draw'
					if (sh.type === 'geo') props.verticalAlign = ({ top: 'start', bottom: 'end' } as any)[label.verticalAlign] ?? 'middle'
				}
				if (Object.keys(props).length) fixes.push({ id: sh.id, type: sh.type, x: sh.x, y: sh.y, props })
			})
			editor.updateShapes(fixes)

			// A tldraw line cannot be filled: a closed, filled outline becomes a closed straight-edged draw shape.
			elements.forEach((e, i) => {
				const sh = shapeOf(i)
				if (sh?.type !== 'line' || !e.closed) return
				const pts = (e.roundness ? curve(e.points) : e.points).map(([x, y]: number[]) => ({ x, y, z: 0.5 }))
				const { x, y, rotation, parentId, index, opacity, isLocked } = sh
				// Create before deleting: a group left with one child dissolves.
				const id = tl.createShapeId()
				ids[i] = id.slice(6)
				editor.createShape({
					id, type: 'draw', x, y, rotation, parentId, index, opacity, isLocked,
					props: {
						segments: pts.slice(1).map((p: any, k: number) => ({ type: 'straight', path: tl.b64Vecs.encodePoints([pts[k], p]) })),
						isClosed: true, isComplete: true, fill: e.fill || 'solid', dash: sh.props.dash, size: sh.props.size, scale: sh.props.scale,
						color: e.fill === 'semi' ? sh.props.color : colorName(e.backgroundColor),
					},
				} as any)
				editor.deleteShapes([sh.id])
			})
			// tldraw gives a shape one colour. An outline of one colour around a fill of another becomes two shapes:
			// the fill underneath, and the outline (with any label and arrows) on top, grouped so they move together.
			elements.forEach((e, i) => {
				const sh = shapeOf(i)
				if (!sh || e.fill || !(GEO.has(e.type) || e.closed) || !/^#/.test(e.backgroundColor) || !/^#/.test(e.strokeColor)) return
				const [line, paint] = [colorName(e.strokeColor), colorName(e.backgroundColor)]
				if (line === paint) return
				// One shape is enough when the fill is the outline colour's own tint.
				if (PAIRS.some(([light, dark]) => paint === light && line === dark) && e.fillStyle === 'solid')
					return editor.updateShapes([{ id: sh.id, type: sh.type, props: { color: line } }])
				const siblings = editor.getSortedChildIdsForParent(sh.parentId)
				const below = editor.getShape(siblings[siblings.indexOf(sh.id) - 1])?.index
				const id = tl.createShapeId()
				const { x, y, rotation, parentId, opacity, isLocked } = sh
				const blank = sh.type === 'geo' ? { richText: tl.toRichText('') } : {}
				editor.createShape({ id, type: sh.type, x, y, rotation, parentId, opacity, isLocked, index: tl.getIndexBetween(below, sh.index), props: { ...sh.props, ...blank, color: paint, dash: 'solid', size: 's', scale: 0.25 } } as any)
				editor.updateShapes([{ id: sh.id, type: sh.type, props: { color: line, fill: 'none' } }])
				if (!String(parentId).startsWith('shape:')) editor.groupShapes([id, sh.id])
			})

			// The importer moves the drawing: find by how much from any unrotated shape.
			const anchor = elements.findIndex((e, i) => !e.angle && shapeOf(i))
			const at = anchor >= 0 ? editor.getShapePageTransform(shapeOf(anchor).id).point() : { x: 0, y: 0 }
			const [dx, dy] = anchor >= 0 ? [at.x - elements[anchor].x, at.y - elements[anchor].y] : [0, 0]
			// tldraw's fonts set text a little wider or narrower: keep each text on its original centre line and aligned edge.
			editor.updateShapes(elements.flatMap((e, i) => {
				const sh = shapeOf(i)
				if (sh?.type !== 'text') return []
				const fix = fixes.find((f) => f.id === sh.id)
				const b = editor.getShapePageBounds(sh.id)
				// Without a layout engine (tests) text has no size: put it back where the importer placed it.
				if (e.angle || !b || b.w < 2 || !(e.width > 0)) return [{ id: sh.id, type: 'text', x: fix.x, y: fix.y }]
				const k = e.textAlign === 'center' ? 0.5 : e.textAlign === 'right' ? 1 : 0
				return [{ id: sh.id, type: 'text', x: sh.x + (e.x + dx + e.width * k) - (b.x + b.w * k), y: sh.y + (e.y + dy + e.height / 2) - b.center.y }]
			}))

			// Frames: the importer has none.
			if (frames.length && anchor >= 0) {
				for (const f of frames) {
					const id = tl.createShapeId()
					editor.createShape({ id, type: 'frame', x: f.x + dx, y: f.y + dy, props: { w: f.width, h: f.height, name: f.name ?? '' } })
					editor.sendToBack([id])
					const kids = elements.flatMap((e, i) => (e.frameId === f.id && shapeOf(i) ? [shapeOf(i)] : []))
					// A grouped child moves with its outermost group.
					const top = (k: any): string => (String(k.parentId).startsWith('shape:') ? top(editor.getShape(k.parentId)) : k.id)
					editor.reparentShapes([...new Set(kids.map(top))] as any, id)
				}
			} else for (const _ of frames) skip('frame')
			const strokes = editor.getCurrentPageShapes().filter((s) => s.type === 'draw')
			// The importer leaves strokes flagged as still being drawn.
			editor.updateShapes(strokes.map((s) => ({ id: s.id, type: 'draw', props: { isComplete: true } })))
			editor.selectNone()
			editor.zoomToFit()
		}
		return {
			// Same three fields the tldraw Obsidian plugin writes (createRawTldrawFile).
			file: JSON.parse(
				JSON.stringify({
					tldrawFileFormatVersion: 1,
					schema: editor.store.schema.serialize(),
					records: editor.store.allRecords(),
				})
			),
			converted: editor.getCurrentPageShapeIds().size,
			skipped,
		}
	} finally {
		editor.dispose()
	}
}

export const TLDATA_START = '!!!_START_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!'
export const TLDATA_END = '!!!_END_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!'

/** The markdown document format of the tldraw Obsidian plugin. */
export function toTldrawMarkdown(
	file: TldrawFile,
	pluginVersion: string,
	tldrawVersion: string,
	/** Vault images, the plugin's way: a link followed by the ^block-id the asset points at. */
	assetLinks: string[] = []
) {
	const data = {
		meta: { uuid: crypto.randomUUID(), 'plugin-version': pluginVersion, 'tldraw-version': tldrawVersion },
		raw: file,
	}
	// Tab-indented like the plugin: one giant line lags Obsidian's markdown view.
	return `---\ntldraw-file: true\n---\n${assetLinks.map((l) => l + '\n').join('\n')}\n\n\`\`\`json ${TLDATA_START}\n${JSON.stringify(data, null, '\t')}\n${TLDATA_END}\n\`\`\``
}
