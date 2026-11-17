import { Modal, Notice, Setting, type TextComponent, type TFile } from 'obsidian'
import type TracingPaper from './main'
import { safeFolder, targetPath } from './parse'

/** One window for everything: pick a folder, search, tick drawings, say where the tldraw copies go. */
export class Picker extends Modal {
	private from: string
	private query = ''
	private dest = ''
	private chosen = new Set<string>()
	private list!: HTMLElement
	private go!: HTMLButtonElement

	constructor(private plugin: TracingPaper, from = '') {
		super(plugin.app)
		this.from = from
	}

	onOpen() {
		const { contentEl } = this
		this.setTitle('Convert Excalidraw drawings to tldraw')
		const all = this.plugin.drawings()
		if (!all.length) return void contentEl.createEl('p', { text: 'No Excalidraw drawings in this vault.' })

		// every folder above a drawing, so a parent such as "Projects" can be picked too
		const folders = [...new Set(all.flatMap((f) => f.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort()
		new Setting(contentEl).setName('From folder').addDropdown((d) => {
			d.addOption('', 'Whole vault')
			for (const f of folders) d.addOption(f, f)
			d.setValue(this.from).onChange((v) => ((this.from = v), this.render()))
		})
		new Setting(contentEl).setName('Find').addSearch((s) => {
			s.setPlaceholder('Part of a name or path').onChange((v) => ((this.query = v.toLowerCase()), this.render()))
			s.inputEl.focus()
		})
		new Setting(contentEl).setName('Save the tldraw copies').addDropdown((d) =>
			d.addOption('', 'Next to each original').addOption('folder', 'In one folder…').setValue(this.dest ? 'folder' : '').onChange((v) => {
				this.dest = v ? this.dest || 'tldraw' : ''
				v ? folderRow.settingEl.show() : folderRow.settingEl.hide()
				folderText.setValue(this.dest)
				this.render()
			})
		)

		let folderText: TextComponent
		const folderRow = new Setting(contentEl).setName('Folder').setDesc('Created if missing. The layout below "From folder" is kept.')
		folderRow.addText((t) => ((folderText = t), t.setValue(this.dest).onChange((v) => ((this.dest = v), this.render()))))
		if (!this.dest) folderRow.settingEl.hide()

		const bar = new Setting(contentEl)
		bar.addButton((b) => b.setButtonText('Tick all shown').onClick(() => this.tick(true)))
		bar.addButton((b) => b.setButtonText('Untick all').onClick(() => this.tick(false)))
		bar.addButton((b) => {
			b.setCta().onClick(() => void this.convert())
			this.go = b.buttonEl
		})
		this.list = contentEl.createDiv()
		// Opened from a folder's menu: that is the ask, so everything in it starts ticked.
		if (this.from) for (const f of this.shown()) if (!this.done(f)) this.chosen.add(f.path)
		this.render()
	}

	private shown() {
		const words = this.query.split(/\s+/).filter(Boolean)
		return this.plugin
			.drawings()
			.filter((f) => (!this.from || f.path.startsWith(this.from + '/')) && words.every((w) => f.path.toLowerCase().includes(w)))
			.sort((a, b) => a.path.localeCompare(b.path))
	}

	private done(f: TFile) {
		const dest = safeFolder(this.dest)
		return dest !== null && !!this.plugin.app.vault.getAbstractFileByPath(targetPath(f.path, dest, this.from))
	}

	private tick(on: boolean) {
		for (const f of this.shown()) if (on && !this.done(f)) this.chosen.add(f.path)
		else this.chosen.delete(f.path)
		this.render()
	}

	private render() {
		if (!this.list) return
		this.list.empty()
		const files = this.shown()
		for (const f of files.slice(0, 200)) {
			const done = this.done(f)
			new Setting(this.list)
				.setName(f.basename.replace(/\.excalidraw$/, ''))
				.setDesc(done ? `${f.parent?.path ?? ''} · already converted` : (f.parent?.path ?? ''))
				.addToggle((t) =>
					t.setValue(this.chosen.has(f.path) && !done).setDisabled(done).onChange((v) => {
						v ? this.chosen.add(f.path) : this.chosen.delete(f.path)
						this.count()
					})
				)
		}
		if (files.length > 200) this.list.createEl('p', { text: `${files.length - 200} more: type in Find to narrow the list.` })
		if (!files.length) this.list.createEl('p', { text: 'No drawings match.' })
		this.count()
	}

	private count() {
		const n = this.plugin.drawings().filter((f) => this.chosen.has(f.path) && !this.done(f)).length
		this.go.setText(n ? `Convert ${n} drawing${n === 1 ? '' : 's'}` : 'Convert')
		this.go.disabled = !n
	}

	private async convert() {
		const dest = safeFolder(this.dest)
		if (dest === null) return void new Notice('That folder name is not allowed. Use a plain path inside the vault.')
		const files = this.plugin.drawings().filter((f) => this.chosen.has(f.path) && !this.done(f))
		this.close()
		await this.plugin.run(files, { dest, root: this.from })
	}

	onClose() {
		this.contentEl.empty()
	}
}
