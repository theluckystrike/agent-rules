import { FuzzySuggestModal, Modal, Setting, type App, type TFolder } from 'obsidian';
import type AgentRulesPlugin from './main';
import { RULE_NAMES, type RuleName } from './rules';
import { TEMPLATES } from './templates';

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private readonly onPick: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder('Choose a folder that agents must not read');
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(false);
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onPick(folder);
	}
}

export class ConfirmModal extends Modal {
	private answered = false;

	constructor(app: App, private readonly message: string, private readonly done: (yes: boolean) => void) {
		super(app);
	}

	static ask(app: App, message: string): Promise<boolean> {
		return new Promise(resolve => new ConfirmModal(app, message, resolve).open());
	}

	onOpen(): void {
		this.setTitle('Replace this file?');
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.finish(false)))
			.addButton(b => b.setButtonText('Replace and keep a backup').setDestructive().onClick(() => this.finish(true)));
	}

	private finish(yes: boolean): void {
		this.answered = true;
		this.done(yes);
		this.close();
	}

	onClose(): void {
		if (!this.answered) this.done(false);
		this.contentEl.empty();
	}
}

export class ReportModal extends Modal {
	constructor(app: App, private readonly heading: string, private readonly lines: string[]) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const ul = this.contentEl.createEl('ul');
		for (const l of this.lines) ul.createEl('li', { text: l });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class CreateRuleModal extends Modal {
	private name: RuleName = 'AGENTS.md';
	private templateId: string;

	constructor(app: App, private readonly plugin: AgentRulesPlugin, private folder: string) {
		super(app);
		this.templateId = plugin.settings.templateId;
	}

	onOpen(): void {
		this.setTitle('New agent rule file');
		const el = this.contentEl;
		new Setting(el).setName('Folder').setDesc('Leave empty for the vault root.')
			.addText(t => t.setValue(this.folder).onChange(v => { this.folder = v.trim(); }));
		new Setting(el).setName('File name')
			.addDropdown(d => {
				for (const n of RULE_NAMES) d.addOption(n, n);
				d.setValue(this.name).onChange(v => { this.name = v as RuleName; });
			});
		new Setting(el).setName('Template')
			.addDropdown(d => {
				for (const t of TEMPLATES) d.addOption(t.id, t.pro && !this.plugin.isPro() ? `${t.name} (Pro)` : t.name);
				d.setValue(this.templateId).onChange(v => { this.templateId = v; });
			});
		new Setting(el).addButton(b => b.setButtonText('Create').setCta().onClick(() => {
			void this.plugin.createRuleFile(this.folder, this.name, this.templateId).then(f => { if (f) this.close(); });
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
