import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type AgentRulesPlugin from './main';
import { RULE_READERS, countTreeFiles, rulesForFolder, type RuleTreeNode } from './rules';
import { MAX_LINES } from './lint';

export const VIEW_TYPE = 'agent-rules-view';

export class AgentRulesView extends ItemView {
	selected: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: AgentRulesPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Agent rules';
	}

	getIcon(): string {
		return 'shield';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	selectFolder(folder: string): void {
		this.selected = folder;
		this.render();
	}

	private button(parent: HTMLElement, text: string, onClick: () => void, pro = false): HTMLButtonElement {
		const b = parent.createEl('button', { text: pro && !this.plugin.isPro() ? `${text} (Pro)` : text, cls: 'agent-rules-button' });
		b.addEventListener('click', onClick);
		return b;
	}

	render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass('agent-rules-view');
		this.renderPrivate(el.createDiv({ cls: 'agent-rules-section' }));
		this.renderTree(el.createDiv({ cls: 'agent-rules-section' }));
		if (this.selected !== null) this.renderApplied(el.createDiv({ cls: 'agent-rules-section' }));
		if (this.plugin.lastLint) this.renderLint(el.createDiv({ cls: 'agent-rules-section' }));
	}

	private renderPrivate(el: HTMLElement): void {
		const s = this.plugin.settings;
		el.createEl('h4', { text: 'Private folders' });
		el.createDiv({ cls: 'agent-rules-hint', text: 'Claude Code reads these deny rules from .claude/settings.json. Agents enforce the rules. A shell command can still read a file.' });
		if (!s.privateFolders.length) el.createDiv({ cls: 'agent-rules-empty', text: 'No private folders yet.' });
		const list = el.createEl('ul', { cls: 'agent-rules-list' });
		for (const f of s.privateFolders) {
			const li = list.createEl('li');
			li.createSpan({ text: `${f}/` });
			if (!this.app.vault.getFolderByPath(f)) li.createSpan({ cls: 'agent-rules-warn', text: ' (missing, the rule stays)' });
			this.button(li, 'Remove', () => { void this.plugin.removePrivateFolder(f); });
		}
		const bar = el.createDiv({ cls: 'agent-rules-bar' });
		this.button(bar, 'Add folder', () => this.plugin.pickPrivateFolder());
		this.button(bar, 'Write rules', () => { void this.plugin.writePrivateRules(true); });
		this.button(bar, 'Copy line', () => { void this.plugin.copySnippet(); });
		this.button(bar, 'Check', () => { void this.plugin.runSelfTest(); }, true);
	}

	private renderTree(el: HTMLElement): void {
		const count = countTreeFiles(this.plugin.tree);
		el.createEl('h4', { text: `Rule files (${count})` });
		const bar = el.createDiv({ cls: 'agent-rules-bar' });
		this.button(bar, 'New', () => this.plugin.openCreateModal(this.selected ?? ''));
		this.button(bar, 'Lint', () => { void this.plugin.runLint(); }, true);
		this.button(bar, 'Refresh', () => this.plugin.rebuildIndex());
		if (!count) {
			el.createDiv({ cls: 'agent-rules-empty', text: 'No AGENTS.md, CLAUDE.md or GEMINI.md in this vault yet. Select New to add one.' });
			return;
		}
		const ul = el.createEl('ul', { cls: 'agent-rules-tree' });
		this.renderNode(ul, this.plugin.tree);
	}

	private renderNode(parent: HTMLElement, node: RuleTreeNode): void {
		const li = parent.createEl('li');
		const row = li.createDiv({ cls: 'agent-rules-folder', text: node.path === '' ? 'Vault root' : `${node.label}/` });
		if (this.selected === node.path) row.addClass('is-selected');
		row.setAttr('title', 'Select to show the rule files that apply here');
		row.addEventListener('click', () => this.selectFolder(node.path));
		const ul = li.createEl('ul');
		for (const f of node.files) {
			const fl = ul.createEl('li', { cls: 'agent-rules-file' });
			const link = fl.createEl('a', { text: f.name, href: '#' });
			link.setAttr('title', `Read by ${RULE_READERS[f.name]}`);
			link.addEventListener('click', ev => { ev.preventDefault(); void this.plugin.openPath(f.path); });
			if (f.name === 'AGENTS.md') {
				const has = new Set(node.files.map(x => x.name));
				if (!has.has('CLAUDE.md')) this.button(fl, 'Add CLAUDE.md import', () => { void this.plugin.writeImportFile(node.path, 'CLAUDE.md'); });
				if (!has.has('GEMINI.md')) this.button(fl, 'Add GEMINI.md import', () => { void this.plugin.writeImportFile(node.path, 'GEMINI.md'); });
			}
		}
		for (const c of node.children) this.renderNode(ul, c);
	}

	private renderApplied(el: HTMLElement): void {
		const folder = this.selected ?? '';
		el.createEl('h4', { text: `Rules for ${folder === '' ? 'the vault root' : `${folder}/`}` });
		const applied = rulesForFolder(folder, this.plugin.byFolder);
		if (!applied.length) { el.createDiv({ cls: 'agent-rules-empty', text: 'No rule file applies to this folder.' }); return; }
		el.createDiv({ cls: 'agent-rules-hint', text: 'An agent that works in this folder loads these files, from the vault root down. The last file is the nearest.' });
		for (const a of applied) {
			const block = el.createDiv({ cls: 'agent-rules-applied' });
			block.createDiv({ cls: 'agent-rules-reader', text: `${a.name}, read by ${RULE_READERS[a.name]}` });
			const ol = block.createEl('ol');
			for (const p of a.chain) {
				const link = ol.createEl('li').createEl('a', { text: p, href: '#' });
				link.addEventListener('click', ev => { ev.preventDefault(); void this.plugin.openPath(p); });
			}
		}
	}

	private renderLint(el: HTMLElement): void {
		const lint = this.plugin.lastLint!;
		el.createEl('h4', { text: 'Lint results' });
		el.createDiv({ cls: 'agent-rules-hint', text: `Token counts are an estimate of 4 characters per token. The Claude Code docs suggest under ${MAX_LINES} lines per file.` });
		const ul = el.createEl('ul', { cls: 'agent-rules-list' });
		for (const r of lint.reports) {
			const li = ul.createEl('li');
			const parts = [`${r.path}, ${r.lines} lines, about ${r.tokens} tokens`];
			if (r.long) parts.push(`longer than ${MAX_LINES} lines`);
			if (r.dead.length) parts.push(`${r.dead.length} dead links (${r.dead.map(d => `line ${d.line} ${d.target}`).join(', ')})`);
			li.setText(parts.join('. '));
			if (r.long || r.dead.length) li.addClass('agent-rules-warn');
		}
		if (lint.duplicates.length) {
			el.createDiv({ cls: 'agent-rules-reader', text: `${lint.duplicates.length} rules appear twice where an agent loads them together` });
			const dl = el.createEl('ul', { cls: 'agent-rules-list' });
			for (const d of lint.duplicates) dl.createEl('li', { text: `${d.rule} (${d.places.map(p => `${p.path} line ${p.line}`).join(', ')})` });
		} else el.createDiv({ cls: 'agent-rules-empty', text: 'No duplicate rules found.' });
	}
}
