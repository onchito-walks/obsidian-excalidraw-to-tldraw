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

	const embedded: Record<string, string> = {}
	const section = text.match(/^#{1,2} Embedded Files\r?\n([\s\S]*?)(?=^%%|^#{1,2} )/m)
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
