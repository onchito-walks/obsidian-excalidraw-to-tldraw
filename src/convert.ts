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
	let hex = color.replace('#', '').toLowerCase()
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

	// The importer trusts its input: drop what would crash it or silently vanish, and say so.
	const elements = scene.elements
		.filter((e) => {
			if (e.isDeleted) return false
			if (!SUPPORTED.has(e.type)) return skip(e.type), false
			if (e.type === 'image' && !files[e.fileId]?.dataURL) return skip('image (source not found)'), false
			const minPoints = e.type === 'freedraw' ? 1 : 2
			if ('freedraw line arrow'.includes(e.type) && !(e.points?.length >= minPoints))
				return skip(`${e.type} (no points)`), false
			return true
		})
		.map((e) => ({
			...e,
			boundElements: e.boundElements ?? null,
			angle: e.angle ?? 0,
			strokeColor: snapColor(e.strokeColor),
			backgroundColor: snapColor(e.backgroundColor),
		}))

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
		editor.updateViewportScreenBounds(new tl.Box(0, 0, 1600, 900))
		if (elements.length) {
			await tl.putExcalidrawContent(editor, { elements, files })
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
