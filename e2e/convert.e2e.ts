import { browser, expect } from '@wdio/globals'

const REPORT = 'Excalidraw to tldraw report.md'

/** The only proof that counts: real Obsidian, the real tldraw plugin, opening what we wrote. */
describe('Excalidraw to tldraw', () => {
	before(async () => {
		await browser.reloadObsidian({ plugins: ['tldraw', 'excalidraw-to-tldraw'] })
	})

	async function convertAll() {
		return browser.executeObsidian(async ({ app }, report) => {
			await app.vault.adapter.remove(report).catch(() => {})
			;(app as any).commands.executeCommandById('excalidraw-to-tldraw:convert-all')
			const deadline = Date.now() + 60_000
			while (Date.now() < deadline && !(await app.vault.adapter.exists(report))) await sleep(200)
			return {
				report: await app.vault.adapter.read(report),
				files: app.vault.getFiles().map((f) => f.path).sort(),
				sketch: await app.vault.adapter.read('sub/Sketch.tldraw.md').catch(() => ''),
				original: await app.vault.adapter.read('sub/Sketch.excalidraw.md'),
			}
		}, REPORT)
	}

	it('converts every drawing, keeps the originals, and skips what is already done', async () => {
		const first = await convertAll()
		expect(first.report).not.toContain('FAILED')
		expect(first.files).toEqual([
			'Diagram-pic.png', // the inline image, saved as an attachment
			'Diagram.excalidraw',
			'Diagram.tldraw.md',
			'Empty.excalidraw.md',
			REPORT,
			'Note.md',
			'sub/Sketch.excalidraw.md',
			'sub/Sketch.tldraw.md',
			'sub/img/pixel.png',
		])
		expect(first.report).toContain('Converted 2 of 3')
		expect(first.report).toContain('1 × frame')
		expect(first.report).toContain('empty drawing')
		expect(first.report).not.toContain('FAILED')
		expect(first.report).not.toContain('source not found')
		expect(first.report).not.toContain('[!warning]')

		// The vault image is linked the tldraw plugin's way, not copied into the file.
		expect(first.sketch).toMatch(/---\n(!?\[\[.*pixel\.png.*\]\]|!?\[.*\]\(.*pixel\.png\))\n\^[0-9a-f-]{36}\n/)
		expect(first.sketch).toContain('"src": "asset:obsidian.blockref.')
		expect(first.sketch).not.toContain('base64')

		const second = await convertAll()
		expect(second.sketch).toBe(first.sketch)
		expect(second.original).toBe(first.original)
		expect(second.original).toContain('compressed-json')
		expect(second.files).toEqual(first.files)
		expect(second.report).toContain('Converted 0 of 3')
	})

	for (const path of ['Diagram.tldraw.md', 'sub/Sketch.tldraw.md']) {
		it(`the tldraw plugin opens and draws ${path}`, async () => {
			const result = await browser.executeObsidian(async ({ app, obsidian }, path) => {
				const errors: string[] = []
				const onError = (e: ErrorEvent) => errors.push(e.message)
				const onRejection = (e: PromiseRejectionEvent) => errors.push(String(e.reason?.message ?? e.reason))
				window.addEventListener('error', onError)
				window.addEventListener('unhandledrejection', onRejection)
				const leaf = app.workspace.getLeaf('tab')
				await leaf.openFile(app.vault.getAbstractFileByPath(path) as InstanceType<typeof obsidian.TFile>)
				const el = () => leaf.view.containerEl
				const deadline = Date.now() + 10_000
				while (Date.now() < deadline && !errors.length && (el().querySelectorAll('.tl-shape').length < 6 || !el().querySelector('.tl-shape[data-shape-type="image"] img'))) await sleep(200)
				window.removeEventListener('error', onError)
				window.removeEventListener('unhandledrejection', onRejection)
				return {
					viewType: leaf.view.getViewType(),
					shapes: [...el().querySelectorAll('.tl-shape')].map((s) => s.getAttribute('data-shape-type')).sort(),
					label: el().textContent?.includes('Converted'),
					image: !!el().querySelector('.tl-shape[data-shape-type="image"] img'),
					errors,
				}
			}, path)
			await browser.pause(1500)
			await browser.saveScreenshot(`.wdio/${path.replace(/\W+/g, '-')}.png`)
			expect(result).toEqual({
				viewType: 'tldraw-view',
				shapes: ['arrow', 'draw', 'geo', 'geo', 'image', 'text'],
				label: true,
				image: true,
				errors: [],
			})
		})
	}
})
