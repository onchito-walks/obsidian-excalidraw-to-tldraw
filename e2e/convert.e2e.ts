import { browser, expect } from '@wdio/globals'

const REPORT = 'Excalidraw to tldraw report.md'

/** The only proof that counts: real Obsidian, the real tldraw plugin, opening what we wrote. */
describe('Excalidraw to tldraw', () => {
	before(async () => {
		await browser.reloadObsidian({ plugins: ['tldraw', 'tracing-paper'] })
	})

	async function convertAll() {
		return browser.executeObsidian(async ({ app }, report) => {
			await app.vault.adapter.remove(report).catch(() => {})
			;(app as any).commands.executeCommandById('tracing-paper:convert-all')
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
		expect(first.report).not.toContain('left behind')
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
				shapes: ['arrow', 'draw', 'frame', 'geo', 'geo', 'image', 'text'],
				label: true,
				image: true,
				errors: [],
			})
		})
	}

	describe('the chooser', () => {
		const open = (from?: string) =>
			browser.executeObsidian(async ({ app }) => {
				;(app as any).commands.executeCommandById('tracing-paper:choose')
				await sleep(500)
				return [...document.querySelectorAll('.modal .setting-item')].map((e) => e.textContent)
			})

		it('lists drawings, filters by search and by folder, and flags the done ones', async () => {
			const rows = await open()
			const names = rows.filter((t) => /excalidraw|Diagram|Sketch|Empty/i.test(t ?? '') || /converted/.test(t ?? ''))
			expect(rows.join('|')).toContain('From folder')
			const view = await browser.executeObsidian(async () => {
				const q = (s: string) => document.querySelector(s) as HTMLInputElement
				const names = () => [...document.querySelectorAll('.modal .setting-item .setting-item-name')].map((e) => e.textContent).filter((n) => ['Diagram', 'Sketch', 'Empty'].includes(n ?? ''))
				const out: any = { all: names() }
				const find = q('.modal input[type=search]')
				find.value = 'sket'; find.dispatchEvent(new Event('input')); await sleep(200)
				out.search = names()
				out.flag = document.querySelector('.modal')!.textContent!.includes('already converted')
				return out
			})
			expect(view.all.sort()).toEqual(['Diagram', 'Empty', 'Sketch'])
			expect(view.search).toEqual(['Sketch'])
			expect(view.flag).toBe(true)
			expect(names.length).toBeGreaterThan(0)
			await browser.keys(['Escape'])
		})

		it('converts the ticked drawings into a folder, mirroring the layout, and refuses a path outside the vault', async () => {
			const res = await browser.executeObsidian(async ({ app }) => {
				;(app as any).commands.executeCommandById('tracing-paper:choose')
				await sleep(500)
				const m = () => document.querySelector('.modal')!
				const fire = (el: HTMLElement | null, v: string) => { const i = el as HTMLInputElement; i.value = v; i.dispatchEvent(new Event(el!.tagName === 'SELECT' ? 'change' : 'input')) }
				const selects = [...m().querySelectorAll('select')] as HTMLSelectElement[]
				fire(selects[1], 'folder'); await sleep(200)
				const text = [...m().querySelectorAll('.setting-item')].find((e) => e.querySelector('.setting-item-name')!.textContent === 'Folder')!.querySelector('input') as HTMLInputElement
				fire(text, '../escape'); await sleep(100)
				const tick = [...m().querySelectorAll('.setting-item')].find((e) => e.textContent!.includes('Sketch'))!.querySelector('.checkbox-container') as HTMLElement
				tick.click(); await sleep(100)
				const go = [...m().querySelectorAll('button')].find((b) => /^Convert \d/.test(b.textContent!)) as HTMLButtonElement
				const label = go.textContent
				go.click(); await sleep(500)
				const refused = !(await app.vault.adapter.exists('out'))
				const stillOpen = !!document.querySelector('.modal')
				fire(text, 'out'); await sleep(100)
				;([...document.querySelectorAll('.modal button')].find((b) => /^Convert \d/.test(b.textContent!)) as HTMLButtonElement).click()
				const deadline = Date.now() + 30000
				while (Date.now() < deadline && !(await app.vault.adapter.exists('out/Excalidraw to tldraw report.md'))) await sleep(200)
				return { label, refused, stillOpen, files: app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith('out/') || p.includes('..')).sort(), original: await app.vault.adapter.exists('sub/Sketch.excalidraw.md') }
			})
			expect(res.label).toBe('Convert 1 drawing')
			expect(res.refused).toBe(true)
			expect(res.files).toEqual(['out/Excalidraw to tldraw report.md', 'out/sub/Sketch.tldraw.md'])
			expect(res.original).toBe(true)
		})

		it('adds convert entries to the file explorer menu for a folder and for a drawing', async () => {
			const titles = await browser.executeObsidian(async ({ app, obsidian }) => {
				const items = (file: any) => { const menu = new obsidian.Menu(); app.workspace.trigger('file-menu', menu, file, 'file-explorer'); return ((menu as any).items ?? []).map((i: any) => i.titleEl?.textContent ?? i.title).filter(Boolean) }
				return { folder: items(app.vault.getAbstractFileByPath('sub')), file: items(app.vault.getAbstractFileByPath('Diagram.excalidraw')), note: items(app.vault.getAbstractFileByPath('Note.md')) }
			})
			expect(titles.folder.join()).toContain('Convert 1 Excalidraw drawing to tldraw')
			expect(titles.file).toContain('Convert to tldraw')
			expect(titles.note.join()).not.toContain('tldraw')
		})
	})
})
