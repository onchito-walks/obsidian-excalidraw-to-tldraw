import LZString from 'lz-string'

export interface ParsedDrawing {
	scene: { elements: any[]; files?: Record<string, any> }
	/** Obsidian "Embedded Files" section: fileId -> raw value ([[link]], URL or $$latex$$). */
	embedded: Record<string, string>
}

/** Reads a plain `.excalidraw` JSON file or an Obsidian Excalidraw markdown file. */
export function parseExcalidraw(text: string): ParsedDrawing {
	if (text.trimStart().startsWith('{')) return { scene: withElements(JSON.parse(text)), embedded: {} }

	const block = text.match(/^#{1,2} Drawing\r?\n```(compressed-json|json)\r?\n([\s\S]*?)\r?\n```/m)
	if (!block) throw new Error('no Excalidraw drawing block found')
	const json =
		block[1] === 'json' ? block[2] : LZString.decompressFromBase64(block[2].replace(/[\r\n]/g, ''))
	if (!json) throw new Error('could not decompress the drawing')

	const embedded: Record<string, string> = Object.create(null) // keys come from the file: no inherited names
	const section = text.match(/^#{1,2} Embedded Files\r?\n([\s\S]*?)(?=^%%|^#{1,2} )/im)
	for (const line of section?.[1].split(/\r?\n/) ?? []) {
		const m = line.match(/^(\S+): (.+)$/)
		if (m) embedded[m[1]] = m[2].trim()
	}
	return { scene: withElements(JSON.parse(json)), embedded }
}

function withElements(scene: any) {
	if (!Array.isArray(scene?.elements)) throw new Error('not an Excalidraw scene')
	return scene
}

/** A vault file name for an image stored inside a drawing. The id comes from the file, so only safe characters are kept. */
export function attachmentName(target: string, id: string, ext: string) {
	return `${target.split('/').pop()!.replace(/\.tldraw\.md$/, '')}-${id.replace(/[^\w-]/g, '').slice(0, 8) || 'image'}.${ext}`
}

/** Text from a drawing, made safe for one cell of the report table: no pipes, line breaks or link brackets. */
export function cellText(s: string) {
	return s.replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').replace(/[[\]]/g, '')
}
