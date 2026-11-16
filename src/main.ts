import { Notice, Plugin, TFile, base64ToArrayBuffer } from 'obsidian'
import { type Tldraw, convertScene, toTldrawMarkdown } from './convert'
import { parseExcalidraw, attachmentName } from './parse'

const MIN_TLDRAW_PLUGIN = '1.33.0' // first release that shares its tldraw with other plugins
const VAULT = 'asset:vault:' // marks an image that lives in the vault until its asset is linked (tldraw only accepts a few URL schemes)
const REPORT = 'Excalidraw to tldraw report.md'
const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
}

export default class TracingPaper extends Plugin {
	onload() {
		this.addCommand({
			id: 'convert-all',
			name: 'Convert all Excalidraw drawings to tldraw',
			callback: () => void this.run(this.app.vault.getFiles().filter((f) => this.isExcalidraw(f))),
		})
		this.addCommand({
			id: 'convert-current',
			name: 'Convert current Excalidraw drawing to tldraw',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile()
				if (!file || !this.isExcalidraw(file)) return false
				if (!checking) void this.run([file])
				return true
			},
		})
	}

	isExcalidraw(f: TFile) {
		return (
			f.extension === 'excalidraw' ||
			f.name.endsWith('.excalidraw.md') ||
			(f.extension === 'md' && !!this.app.metadataCache.getFileCache(f)?.frontmatter?.['excalidraw-plugin'])
		)
	}

	/** Originals are never touched; an existing target is never overwritten. */
	async run(files: TFile[]) {
		// Conversion runs on the tldraw plugin's own copy of tldraw: same importer, same schema as the plugin that opens the result.
		const tldrawPlugin = (this.app as any).plugins?.plugins?.tldraw
		const tl: Tldraw | undefined = tldrawPlugin?.instance?.packages?.tldraw
		if (!tl?.putExcalidrawContent) {
			new Notice(`Tracing Paper needs the tldraw plugin, ${MIN_TLDRAW_PLUGIN} or newer, installed and enabled.`, 10000)
			return
		}
		const installed: string = tldrawPlugin.manifest.version
		const tldrawVersion: string =
			(window as any).__TLDRAW_LIBRARY_VERSIONS__?.versions?.find((v: any) => v.name === 'tldraw')?.version ?? 'unknown'
		const rows: string[] = []
		let made = 0
		const progress = new Notice('', 0)
		for (const [i, file] of files.entries()) {
			progress.setMessage(`Excalidraw → tldraw: ${i + 1}/${files.length}`)
			const target = file.path.replace(/(\.excalidraw)?\.(md|excalidraw)$/, '') + '.tldraw.md'
			try {
				if (this.app.vault.getAbstractFileByPath(target)) {
					rows.push(`| [[${file.path}]] | already converted | [[${target}]] |`)
					continue
				}
				const { scene, embedded } = parseExcalidraw(await this.app.vault.read(file))
				const missing = await this.loadEmbeddedImages(scene, embedded, file.path, target)
				const { file: tldrawFile, converted, skipped } = await convertScene(tl, scene)
				if (!converted && !Object.keys(skipped).length) {
					rows.push(`| [[${file.path}]] | empty drawing, nothing to convert | |`)
					continue
				}
				// Vault images stay vault files: point each asset at a linked block, as the tldraw plugin does.
				const assetLinks: string[] = []
				for (const asset of tldrawFile.records as any[]) {
					const linked = asset.typeName === 'asset' && asset.props.src?.startsWith(VAULT) && asset.props.src.slice(VAULT.length)
					if (!linked) continue
					const image = this.app.vault.getAbstractFileByPath(linked)
					if (!(image instanceof TFile)) continue
					const id = crypto.randomUUID()
					asset.props.src = `asset:obsidian.blockref.${id}`
					assetLinks.push(`${this.app.fileManager.generateMarkdownLink(image, target)}\n^${id}`)
				}
				await this.app.vault.create(
					target,
					toTldrawMarkdown(tldrawFile, installed, tldrawVersion, assetLinks)
				)
				made++
				const left = [...Object.entries(skipped).map(([why, n]) => `${n} × ${why}`), ...missing]
				rows.push(
					`| [[${file.path}]] | ${converted} shapes${left.length ? `; left behind: ${left.join(', ')}` : ''} | [[${target}]] |`
				)
			} catch (e) {
				console.error('tracing-paper', file.path, e)
				rows.push(`| [[${file.path}]] | FAILED: ${String((e as Error)?.message ?? e).replace(/\|/g, '/')} | |`)
			}
		}
		progress.hide()

		const report = [
			`Converted ${made} of ${files.length} Excalidraw drawings. The originals were not changed.`,
			'',
			'| Excalidraw | Result | tldraw |',
			'|---|---|---|',
			...rows,
		].join('\n')
		const existing = this.app.vault.getAbstractFileByPath(REPORT)
		if (existing instanceof TFile) await this.app.vault.modify(existing, report)
		else await this.app.vault.create(REPORT, report)
		new Notice(`Excalidraw → tldraw: converted ${made} of ${files.length}. See "${REPORT}".`, 10000)
	}

	/** Every image ends up as a vault file the converter can point at: Obsidian Excalidraw already links them. */
	async loadEmbeddedImages(scene: any, embedded: Record<string, string>, sourcePath: string, target: string) {
		const missing: string[] = []
		scene.files = Object.assign(Object.create(null), scene.files) // ids come from the file: no inherited names
		for (const [id, raw] of Object.entries(embedded)) {
			const link = raw.match(/^\[\[([^\]|#]+)/)?.[1]
			const dest = link && this.app.metadataCache.getFirstLinkpathDest(link, sourcePath)
			const mimeType = dest && MIME[dest.extension.toLowerCase()]
			if (!dest || !mimeType) {
				// shortcut: web images, LaTeX and embedded notes are not carried over; fetch/render them here if that ever matters.
				if (scene.elements.some((e: any) => e.fileId === id && !e.isDeleted)) missing.push(`embed ${raw.slice(0, 60)}`)
				continue
			}
			scene.files[id] = { mimeType, size: dest.stat.size, dataURL: VAULT + dest.path }
		}
		// tldraw's plugin does not display inline (data:) images, so those become vault attachments too.
		for (const [id, f] of Object.entries<any>(scene.files)) {
			const inline = typeof f?.dataURL === 'string' && f.dataURL.match(/^data:(image\/[\w+.-]+);base64,(.*)$/s)
			const ext = inline && Object.keys(MIME).find((k) => MIME[k] === inline[1])
			if (!inline || !ext || !scene.elements.some((e: any) => e.fileId === id && !e.isDeleted)) continue
			const name = attachmentName(target, id, ext)
			const path = await this.app.fileManager.getAvailablePathForAttachment(name, target)
			await this.app.vault.createBinary(path, base64ToArrayBuffer(inline[2]))
			f.dataURL = VAULT + path
		}
		return missing
	}
}
