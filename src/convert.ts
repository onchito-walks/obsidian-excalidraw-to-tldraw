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
			const fill = !GEO.has(e.type) ? '' : WHITE.has(backgroundColor as string) ? 'semi' : e.fillStyle === 'solid' && DARK.has(backgroundColor as string) ? 'fill' : ''
			return { ...e, boundElements: e.boundElements ?? null, angle: e.angle ?? 0, strokeColor, backgroundColor: fill === 'semi' ? strokeColor : backgroundColor, fill }
		})

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
			const byId = new Map(elements.map((e) => [e.id, e]))
			const fixes: any[] = []
			elements.forEach((e, i) => {
				const sh = shapeOf(i)
				if (!sh) return // a label: the importer folds it into its container
				const props: Record<string, unknown> = {}
				// Excalidraw's widths are 1, 2 and 4; tldraw's xl is a marker, so the widest stops at l.
				if ('size' in sh.props && sh.type !== 'text') props.size = e.strokeWidth >= 3 ? 'l' : e.strokeWidth >= 1.5 ? 'm' : 's'
				if (e.fill) props.fill = e.fill
				if (sh.type === 'text') Object.assign(props, { size: 'm', scale: (e.fontSize || 20) / 24, font: FONTS[e.fontFamily] ?? 'draw' }) // m is 24px: exact size
				const label = e.boundElements?.map((b: any) => byId.get(b.id)).find((b: any) => b?.type === 'text')
				if (label && 'font' in sh.props) {
					props.font = FONTS[label.fontFamily] ?? 'draw'
					if (sh.type === 'geo') props.verticalAlign = ({ top: 'start', bottom: 'end' } as any)[label.verticalAlign] ?? 'middle'
				}
				if (Object.keys(props).length) fixes.push({ id: sh.id, type: sh.type, x: sh.x, y: sh.y, props })
			})
			editor.updateShapes(fixes)
			// Rescaling text nudges it; put it back where the importer placed it.
			editor.updateShapes(fixes.filter((f) => f.type === 'text').map((f) => ({ id: f.id, type: 'text', x: f.x, y: f.y })))

			// Frames: the importer has none. It also moves the drawing, so find by how much from any unrotated shape.
			const anchor = elements.findIndex((e, i) => !e.angle && shapeOf(i))
			if (frames.length && anchor >= 0) {
				const at = editor.getShapePageTransform(shapeOf(anchor).id).point()
				const [dx, dy] = [at.x - elements[anchor].x, at.y - elements[anchor].y]
				for (const f of frames) {
					const id = tl.createShapeId()
					editor.createShape({ id, type: 'frame', x: f.x + dx, y: f.y + dy, props: { w: f.width, h: f.height, name: f.name ?? '' } })
					editor.sendToBack([id])
					const kids = elements.flatMap((e, i) => (e.frameId === f.id && shapeOf(i) ? [shapeOf(i)] : []))
					// A grouped child moves with its group.
					editor.reparentShapes([...new Set(kids.map((k) => (k.parentId.startsWith('shape:') ? k.parentId : k.id)))], id)
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
