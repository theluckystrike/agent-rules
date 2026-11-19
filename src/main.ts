import { Notice, Plugin, TFile, TFolder, debounce, getAllTags, normalizePath, type TAbstractFile } from 'obsidian';
import { createGitHubSponsors, showProNotice } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';
import { SPONSORS } from './pro';
import { AgentRulesSettingTab, DEFAULT_SETTINGS, normalizeSettings, type AgentRulesSettings } from './settings';
import { buildRuleTree, collectRuleFiles, folderOf, indexByFolder, isRuleName, joinPath, baseName, type RuleFile, type RuleName, type RuleTreeNode } from './rules';
import { CURSOR_IGNORE, GEMINI_IGNORE, SETTINGS_PATH, cleanFolder, countCovered, instructionSnippet, mergeClaudeSettings, mergeIgnoreBlock, selfTest, type PrivateSet } from './privacy';
import { backupPath, mirrorContent, mirrorState, type MirrorTarget } from './mirror';
import { duplicatesLoadedTogether, lintFile, type Duplicate, type LintReport } from './lint';
import { templateById } from './templates';
import { AgentRulesView, VIEW_TYPE } from './view';
import { ConfirmModal, CreateRuleModal, FolderSuggestModal, ReportModal } from './modals';

export interface LintResult {
	reports: LintReport[];
	duplicates: Duplicate[];
}

export default class AgentRulesPlugin extends Plugin {
	settings: AgentRulesSettings = { ...DEFAULT_SETTINGS, privateFolders: [], privateTags: [], managedDeny: [], frozenTagFiles: [] };
	pro: SponsorsManager | null = null;
	ruleFiles: RuleFile[] = [];
	byFolder = new Map<string, RuleFile[]>();
	tree: RuleTreeNode = buildRuleTree([]);
	lastLint: LintResult | null = null;
	private tab: AgentRulesSettingTab | null = null;
	private writing: Promise<boolean> | null = null;
	private readonly scheduleRebuild = debounce(() => this.rebuildIndex(), 300, true);
	private readonly scheduleTagWrite = debounce(() => { void this.refreshTagRules(); }, 250, true);
	private watching = false;
	private lapseNoticeShown = false;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		await this.loadSettings();
		this.tab = new AgentRulesSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.register(pro.onChange(() => { this.tab?.update(); this.refreshViews(); }));
		this.registerView(VIEW_TYPE, leaf => new AgentRulesView(leaf, this));
		this.addRibbonIcon('shield', 'Open agent rules', () => { void this.activateView(); });

		this.addCommand({ id: 'open-view', name: 'Open the rules view', callback: () => { void this.activateView(); } });
		this.addCommand({ id: 'add-private-folder', name: 'Add a private folder for agents', callback: () => this.pickPrivateFolder() });
		this.addCommand({ id: 'write-private-rules', name: 'Write the private folder rules', callback: () => { void this.writePrivateRules(true); } });
		this.addCommand({ id: 'copy-instruction-line', name: 'Copy the private folder line for other agents', callback: () => { void this.copySnippet(); } });
		this.addCommand({ id: 'new-rule-file', name: 'New rule file', callback: () => this.openCreateModal(this.activeFolder()) });
		this.addCommand({ id: 'lint-rule-files', name: 'Check all rule files', callback: () => { void this.runLint(); } });
		this.addCommand({ id: 'self-test', name: 'Check the written private rules', callback: () => { void this.runSelfTest(); } });

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFolder)) return;
			const path = file.path === '/' ? '' : file.path;
			const isPrivate = this.settings.privateFolders.includes(path);
			if (path) {
				menu.addItem(item => item.setTitle(isPrivate ? 'Remove from private folders' : 'Make private for agents').setIcon('shield')
					.onClick(() => { void (isPrivate ? this.removePrivateFolder(path) : this.addPrivateFolder(path)); }));
			}
			menu.addItem(item => item.setTitle('New agent rule file here').setIcon('file-plus').onClick(() => this.openCreateModal(path)));
			menu.addItem(item => item.setTitle('Show agent rules for this folder').setIcon('scroll-text').onClick(() => { void this.showFolder(path); }));
		}));
		this.app.workspace.onLayoutReady(() => {
			this.rebuildIndex();
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}

	onunload(): void {
		this.scheduleRebuild.cancel();
		this.scheduleTagWrite.cancel();
	}

	/**
	 * Watches the vault for rule files, renamed private folders and tagged notes.
	 * loadSettings calls it, so the watchers start once, as soon as the settings exist. Each one goes through registerEvent.
	 */
	private watchVault(): void {
		if (this.watching) return;
		this.watching = true;
		const onChange = (file: TAbstractFile, oldPath?: string): void => {
			if (file instanceof TFolder || isRuleName(file.name) || (oldPath !== undefined && isRuleName(baseName(oldPath)))) this.scheduleRebuild();
			if (file instanceof TFile && file.extension === 'md' && this.settings.privateTags.length) this.scheduleTagWrite();
		};
		this.registerEvent(this.app.vault.on('create', f => onChange(f)));
		this.registerEvent(this.app.vault.on('delete', f => { onChange(f); if (f instanceof TFolder) this.refreshViews(); }));
		this.registerEvent(this.app.vault.on('rename', (f, old) => {
			onChange(f, old);
			if (f instanceof TFolder) void this.movePrivateFolder(old, f.path);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', () => { if (this.settings.privateTags.length) this.scheduleTagWrite(); }));
	}

	/** Keeps a renamed private folder private. A deleted folder keeps its rule, and the view marks it as missing. */
	async movePrivateFolder(oldPath: string, newPath: string): Promise<void> {
		let moved = false;
		const next = this.settings.privateFolders.map(f => {
			if (f === oldPath || f.startsWith(oldPath + '/')) { moved = true; return newPath + f.slice(oldPath.length); }
			return f;
		});
		if (!moved) return;
		this.settings.privateFolders = [...new Set(next)].sort();
		await this.saveSettings();
		new Notice(`Agent Rules moved the private folder ${oldPath} to ${newPath}.`);
		await this.writePrivateRules(false);
	}

	/** Writes the rules again when the set of tagged notes changed. Pro only. */
	async refreshTagRules(): Promise<void> {
		if (!this.isPro() || !this.settings.privateTags.length) return;
		const now = this.taggedFiles();
		const before = this.settings.frozenTagFiles;
		if (now.length === before.length && now.every((p, i) => p === before[i])) return;
		await this.writePrivateRules(false);
	}

	isPro(): boolean {
		return this.pro?.isPro() === true;
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<AgentRulesSettings> | null);
		this.watchVault();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async setSetting(key: string, value: unknown): Promise<void> {
		if ((key === 'cursorTarget' || key === 'geminiTarget') && value === true && !this.isPro()) {
			showProNotice(this.pro, 'Pro is needed for the Cursor and Gemini ignore files.');
			this.tab?.update();
			return;
		}
		if (key === 'privateTagsText') {
			const tags = String(value).split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
			this.settings.privateTags = [...new Set(tags)];
		} else if (key === 'cursorTarget' || key === 'geminiTarget') {
			this.settings[key] = value === true;
		} else if (key === 'templateId' && typeof value === 'string') {
			this.settings.templateId = templateById(value).id;
		} else return;
		await this.saveSettings();
		this.refreshViews();
	}

	/** Rebuilds the rule file index from the vault file list. One pass over the notes. */
	rebuildIndex(): void {
		this.ruleFiles = collectRuleFiles(this.app.vault.getMarkdownFiles().map(f => f.path));
		this.byFolder = indexByFolder(this.ruleFiles);
		this.tree = buildRuleTree(this.ruleFiles);
		this.refreshViews();
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof AgentRulesView) view.render();
		}
	}

	async activateView(): Promise<AgentRulesView | null> {
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: true });
		const view = leaf.view;
		return view instanceof AgentRulesView ? view : null;
	}

	async showFolder(folder: string): Promise<void> {
		const view = await this.activateView();
		view?.selectFolder(folder);
	}

	activeFolder(): string {
		const file = this.app.workspace.getActiveFile();
		return file ? folderOf(file.path) : '';
	}

	// ---------- Private folders ----------

	pickPrivateFolder(): void {
		new FolderSuggestModal(this.app, folder => { void this.addPrivateFolder(folder.path); }).open();
	}

	async addPrivateFolder(path: string): Promise<void> {
		const clean = cleanFolder(path);
		if (!clean) { new Notice('Choose a folder inside the vault. The vault root cannot be private.'); return; }
		if (this.settings.privateFolders.includes(clean)) { new Notice(`${clean} is already private.`); return; }
		this.settings.privateFolders = [...this.settings.privateFolders, clean].sort();
		await this.saveSettings();
		await this.writePrivateRules(true);
	}

	async removePrivateFolder(path: string): Promise<void> {
		this.settings.privateFolders = this.settings.privateFolders.filter(f => f !== path);
		await this.saveSettings();
		await this.writePrivateRules(true);
	}

	/** The notes with a private tag. Pro only. */
	taggedFiles(): string[] {
		if (!this.isPro() || !this.settings.privateTags.length) return [];
		const want = new Set(this.settings.privateTags.map(t => `#${t.toLowerCase()}`));
		const out: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache ? getAllTags(cache) ?? [] : [];
			if (tags.some(t => want.has(t.toLowerCase()))) out.push(file.path);
		}
		return out.sort();
	}

	privateSet(): PrivateSet {
		// Without Pro, the tag rules that Pro wrote stay as they are. They are not removed.
		return { folders: [...this.settings.privateFolders], files: this.isPro() ? this.taggedFiles() : [...this.settings.frozenTagFiles] };
	}

	private async readDot(path: string): Promise<string | null> {
		const adapter = this.app.vault.adapter;
		return (await adapter.exists(path)) ? adapter.read(path) : null;
	}

	private async ensureDir(dir: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parts = dir.split('/').filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			const p = parts.slice(0, i).join('/');
			if (!(await adapter.exists(p))) await adapter.mkdir(p);
		}
	}

	/** Copies a file to the hidden backup folder before the plugin changes it. */
	async backup(path: string, text: string): Promise<string> {
		const target = normalizePath(backupPath(path, new Date()));
		await this.ensureDir(folderOf(target));
		await this.app.vault.adapter.write(target, text);
		return target;
	}

	/**
	 * Reads a file, merges, reads it again just before the write, and writes only when nothing changed in between.
	 * A change in between starts the merge again, up to 3 times. A failed write gives a notice and changes nothing.
	 */
	private async mergeWrite<R extends { ok: true; text: string; changed: boolean } | { ok: false; error: string }>(path: string, merge: (text: string | null) => R): Promise<{ ok: boolean; result: R | null }> {
		const adapter = this.app.vault.adapter;
		for (let attempt = 0; attempt < 3; attempt++) {
			let before: string | null;
			try {
				before = await this.readDot(path);
			} catch {
				new Notice(`Agent Rules could not read ${path}. The plugin did not change it.`, 10000);
				return { ok: false, result: null };
			}
			const result = merge(before);
			if (!result.ok) { new Notice(result.error, 10000); return { ok: false, result }; }
			if (!result.changed) return { ok: true, result };
			try {
				const now = await this.readDot(path);
				if (now !== before) continue;
				if (before !== null) await this.backup(path, before);
				const dir = folderOf(path);
				if (dir) await this.ensureDir(dir);
				await adapter.write(path, result.text);
				return { ok: true, result };
			} catch {
				new Notice(`Agent Rules could not write ${path}. The plugin did not change it.`, 10000);
				return { ok: false, result: null };
			}
		}
		new Notice(`${path} changed while Agent Rules wrote it. The plugin did not change it. Try again.`, 10000);
		return { ok: false, result: null };
	}

	/** Writes the deny rules and, with Pro, the ignore blocks. Returns false when a file was refused. One write at a time. */
	async writePrivateRules(notify: boolean): Promise<boolean> {
		while (this.writing) await this.writing;
		this.writing = this.doWrite(notify);
		try {
			return await this.writing;
		} finally {
			this.writing = null;
			this.refreshViews();
		}
	}

	private async doWrite(notify: boolean): Promise<boolean> {
		const set = this.privateSet();
		const pro = this.isPro();
		const claude = await this.mergeWrite(SETTINGS_PATH, text => mergeClaudeSettings(text, set, this.settings.managedDeny));
		if (!claude.ok || !claude.result?.ok) return false;
		this.settings.managedDeny = claude.result.rules;
		if (pro) this.settings.frozenTagFiles = [...set.files];
		await this.saveSettings();
		const done = [SETTINGS_PATH];
		let ok = true;
		if (pro) {
			for (const [name, on] of [[CURSOR_IGNORE, this.settings.cursorTarget], [GEMINI_IGNORE, this.settings.geminiTarget]] as const) {
				// A target that is off removes the managed block and keeps the rest of the file.
				const r = await this.mergeWrite(name, text => (text === null && !on ? { ok: true as const, text: '', changed: false } : mergeIgnoreBlock(text, on ? set : { folders: [], files: [] }, name)));
				if (!r.ok) ok = false;
				else if (on) done.push(name);
			}
		} else if ((this.settings.frozenTagFiles.length || this.settings.cursorTarget || this.settings.geminiTarget) && !this.lapseNoticeShown) {
			// A lapsed Pro never lowers privacy. The rules and ignore blocks that Pro wrote stay as they are.
			this.lapseNoticeShown = true;
			new Notice('Pro is off. Agent Rules keeps the tag rules and ignore files that Pro wrote, but it does not update them.', 10000);
		}
		if (notify) {
			const n = set.folders.length + set.files.length;
			new Notice(n ? `Agent Rules wrote ${n} private paths to ${done.join(', ')}. Agents enforce these rules. A shell command can still read a file.` : `Agent Rules removed its private rules from ${done.join(', ')}.`);
		}
		return ok;
	}

	async copySnippet(): Promise<void> {
		const text = instructionSnippet(this.privateSet());
		if (!text) { new Notice('Add a private folder first.'); return; }
		try {
			await navigator.clipboard.writeText(text);
			new Notice('Copied the line. Paste it into the instructions of your agent.');
		} catch {
			new ReportModal(this.app, 'Line for other agents', [text]).open();
		}
	}

	async runSelfTest(): Promise<string[] | null> {
		if (!this.isPro()) { showProNotice(this.pro, 'Pro is needed to check the written rules.'); return null; }
		const set = this.privateSet();
		const rows = selfTest(set, await this.readDot(SETTINGS_PATH),
			this.settings.cursorTarget ? await this.readDot(CURSOR_IGNORE) : undefined,
			this.settings.geminiTarget ? await this.readDot(GEMINI_IGNORE) : undefined);
		const covered = countCovered(this.app.vault.getFiles().map(f => f.path), set);
		const lines = [`${covered} files are inside the private set.`];
		for (const r of rows) {
			lines.push(r.ok ? `${r.target} covers every private path.` : `${r.target} misses ${r.missing.length} rules. ${r.note} Select Write the rules now to fix it.`.replace(/\s+/g, ' '));
		}
		lines.push('Agents enforce these rules. A shell command or a script can still read a file.');
		new ReportModal(this.app, 'Private rule check', lines).open();
		return lines;
	}

	// ---------- Rule files ----------

	openCreateModal(folder: string): void {
		new CreateRuleModal(this.app, this, folder).open();
	}

	async openPath(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file) await this.app.workspace.getLeaf(false).openFile(file);
	}

	/** Creates a rule file from a template. Never replaces a file. */
	async createRuleFile(folder: string, name: RuleName, templateId: string): Promise<TFile | null> {
		const template = templateById(templateId);
		if (template.pro && !this.isPro()) { showProNotice(this.pro, 'Pro is needed for the template pack.'); return null; }
		const clean = folder === '' ? '' : cleanFolder(folder);
		if (clean === null || (clean !== '' && !this.app.vault.getFolderByPath(clean))) { new Notice('That folder does not exist.'); return null; }
		const path = joinPath(clean, name);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) { new Notice(`${path} already exists. The plugin opened it.`); await this.openPath(path); return existing; }
		const file = await this.app.vault.create(path, template.body);
		await this.openPath(path);
		return file;
	}

	/**
	 * Writes a CLAUDE.md or GEMINI.md that imports the AGENTS.md of the same folder.
	 * Asks before it replaces a file that a person wrote, and keeps a backup.
	 */
	async writeImportFile(folder: string, target: MirrorTarget, confirm = (msg: string): Promise<boolean> => ConfirmModal.ask(this.app, msg)): Promise<'created' | 'in-step' | 'replaced' | 'kept' | 'no-agents'> {
		if (!this.app.vault.getFileByPath(joinPath(folder, 'AGENTS.md'))) { new Notice('This folder has no AGENTS.md.'); return 'no-agents'; }
		const path = joinPath(folder, target);
		const file = this.app.vault.getFileByPath(path);
		const text = file ? await this.app.vault.read(file) : null;
		const state = mirrorState(target, text);
		if (state === 'in-step') { new Notice(`${path} already imports AGENTS.md.`); return 'in-step'; }
		if (state === 'missing' || !file) {
			await this.app.vault.create(path, mirrorContent(target));
			this.rebuildIndex();
			return 'created';
		}
		const yes = await confirm(`${path} has its own text. Replace it with one import line? The plugin keeps a backup in .agent-rules-backup.`);
		if (!yes) return 'kept';
		await this.backup(path, text ?? '');
		await this.app.vault.modify(file, mirrorContent(target));
		return 'replaced';
	}

	async runLint(): Promise<LintResult | null> {
		if (!this.isPro()) { showProNotice(this.pro, 'Pro is needed to check rule files.'); return null; }
		const vault = this.app.vault;
		const files: { path: string; text: string }[] = [];
		const reports: LintReport[] = [];
		for (const rf of this.ruleFiles) {
			const file = vault.getFileByPath(rf.path);
			if (!file) continue;
			const text = await vault.cachedRead(file);
			files.push({ path: rf.path, text });
			reports.push(lintFile(rf.path, rf.folder, text,
				p => vault.getAbstractFileByPath(p) !== null,
				l => this.app.metadataCache.getFirstLinkpathDest(l, rf.path) !== null));
		}
		this.lastLint = { reports, duplicates: duplicatesLoadedTogether(files) };
		const view = await this.activateView();
		view?.render();
		return this.lastLint;
	}
}
