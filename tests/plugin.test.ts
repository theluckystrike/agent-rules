import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import AgentRulesPlugin from '../src/main';
import { AgentRulesView, VIEW_TYPE } from '../src/view';
import { AgentRulesSettingTab, DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { BLOCK_BEGIN } from '../src/privacy';
import { mirrorContent } from '../src/mirror';
import manifest from '../manifest.json';
import whatsNew from '../src/whats-new.json';

const plugins: AgentRulesPlugin[] = [];
afterEach(() => { for (const p of plugins.splice(0)) p.onunload(); document.body.empty(); vi.restoreAllMocks(); });

const proStub = (on: boolean) => ({ isPro: () => on, getState: () => ({ status: on ? 'pro' : 'signed-out', lastAttemptAt: 0 }), hasToken: () => on, config: { sponsorLogin: 'theluckystrike' }, onChange: () => () => undefined, refresh: async () => undefined, init: () => undefined }) as never;

const base: Record<string, string> = {
	'AGENTS.md': '# Root rules\n- Ask before you delete a note.\n',
	'Projects/AGENTS.md': '# Project\n- Ask before you delete a note.\n@docs/missing.md\n',
	'Projects/App/CLAUDE.md': '# My own Claude rules\n',
	'Journal/2026-11-19.md': 'dear diary',
	'Notes/secret.md': '---\ntags: [private]\n---\nsecret',
	'Notes/open.md': 'open',
};

async function setup(files: Record<string, string> = base, pro = false) {
	const app = App.createConfigured__({ files });
	const plugin = new AgentRulesPlugin(app as never, manifest as never);
	plugins.push(plugin);
	await plugin.loadSettings();
	plugin.pro = proStub(pro);
	plugin.rebuildIndex();
	const notices: string[] = [];
	vi.spyOn(Notice.prototype, 'constructor__').mockImplementation((m: DocumentFragment | string) => { notices.push(String(typeof m === 'string' ? m : m.textContent)); });
	const adapter = app.vault.adapter;
	const read = async (p: string): Promise<string | null> => ((await adapter.exists(p)) ? adapter.read(p) : null);
	return { app, plugin, notices, adapter, read };
}

describe('settings', () => {
	it('repairs bad saved settings', () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ privateFolders: ['A', 'A', 3, ''] as never, privateTags: ['#x', 'x'], cursorTarget: 'yes' as never, templateId: 'nope' })).toEqual({ ...DEFAULT_SETTINGS, privateFolders: ['A'], privateTags: ['x'] });
	});
	it('keeps the whats-new file in step with the manifest', () => {
		expect(whatsNew.id).toBe(manifest.id);
		expect(whatsNew.version).toBe(manifest.version);
	});
	it('leads the settings tab with the private folders', async () => {
		const { app, plugin } = await setup();
		const tab = new AgentRulesSettingTab(app as never, plugin);
		tab.plugin = plugin;
		const defs = tab.productSettingDefinitions() as { name?: string; heading?: string }[];
		expect(defs[0]!.name).toBe('Private folders for agents');
		expect(defs[1]!.heading).toBe('Private folders');
	});
	it('refuses Pro targets without Pro and stores tags', async () => {
		const { plugin, notices } = await setup();
		await plugin.setSetting('cursorTarget', true);
		expect(plugin.settings.cursorTarget).toBe(false);
		expect(notices.join(' ')).toMatch(/Pro is needed/);
		await plugin.setSetting('privateTagsText', '#private, secret ,');
		expect(plugin.settings.privateTags).toEqual(['private', 'secret']);
	});
});

describe('private folders', () => {
	it('writes Claude Code deny rules and keeps other keys', async () => {
		const files = { ...base, '.claude/settings.json': '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n' };
		const { plugin, read, notices } = await setup(files);
		await plugin.addPrivateFolder('Journal');
		const json = JSON.parse((await read('.claude/settings.json'))!);
		expect(json.model).toBe('opus');
		expect(json.permissions.allow).toEqual(['Bash(ls)']);
		expect(json.permissions.deny).toEqual(['Read(/Journal/**)', 'Edit(/Journal/**)']);
		expect(plugin.settings.managedDeny).toEqual(['Read(/Journal/**)', 'Edit(/Journal/**)']);
		expect(notices.at(-1)).toMatch(/Agents enforce these rules. A shell command can still read a file./);
		const backups = await plugin.app.vault.adapter.list('.agent-rules-backup/.claude');
		expect(backups.files).toHaveLength(1);
	});

	it('creates .claude/settings.json in a vault without it, and removes its rules again', async () => {
		const { plugin, read } = await setup();
		await plugin.addPrivateFolder('Journal');
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny).toHaveLength(2);
		await plugin.removePrivateFolder('Journal');
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions).toEqual({});
		expect(plugin.settings.managedDeny).toEqual([]);
	});

	it('refuses a malformed settings file with a notice and writes nothing', async () => {
		const bad = '{\n  // my comment\n  "permissions": {}\n}\n';
		const { plugin, read, notices, adapter } = await setup({ ...base, '.claude/settings.json': bad });
		const write = vi.spyOn(adapter, 'write');
		await plugin.addPrivateFolder('Journal');
		expect(await read('.claude/settings.json')).toBe(bad);
		expect(write).not.toHaveBeenCalled();
		expect(notices.join(' ')).toMatch(/is not valid JSON/);
		expect(plugin.settings.managedDeny).toEqual([]);
	});

	it('is idempotent and makes no second write', async () => {
		const { plugin, adapter } = await setup();
		await plugin.addPrivateFolder('Journal');
		const write = vi.spyOn(adapter, 'write');
		await plugin.writePrivateRules(false);
		expect(write).not.toHaveBeenCalled();
	});

	it('refuses the vault root and a repeated folder', async () => {
		const { plugin, notices } = await setup();
		await plugin.addPrivateFolder('/');
		await plugin.addPrivateFolder('Journal');
		await plugin.addPrivateFolder('Journal/');
		expect(plugin.settings.privateFolders).toEqual(['Journal']);
		expect(notices.join(' ')).toMatch(/vault root cannot be private/);
		expect(notices.join(' ')).toMatch(/already private/);
	});

	it('writes ignore blocks only with Pro', async () => {
		const { plugin, read } = await setup(base, false);
		plugin.settings.cursorTarget = true;
		plugin.settings.geminiTarget = true;
		await plugin.addPrivateFolder('Journal');
		expect(await read('.cursorignore')).toBeNull();
		plugin.pro = proStub(true);
		await plugin.writePrivateRules(false);
		expect(await read('.cursorignore')).toContain(`${BLOCK_BEGIN}\n/Journal/\n`);
		expect(await read('.geminiignore')).toContain('/Journal/');
		plugin.settings.cursorTarget = false;
		await plugin.writePrivateRules(false);
		expect(await read('.cursorignore')).toBe('');
	});

	it('leaves an existing ignore file alone without Pro', async () => {
		const { plugin, read } = await setup({ ...base, '.cursorignore': 'node_modules/\n' }, false);
		plugin.settings.cursorTarget = true;
		await plugin.addPrivateFolder('Journal');
		expect(await read('.cursorignore')).toBe('node_modules/\n');
	});

	it('adds notes with a private tag with Pro', async () => {
		const { plugin, read } = await setup(base, true);
		plugin.settings.privateTags = ['private'];
		vi.spyOn(plugin.app.metadataCache, 'getFileCache').mockImplementation(f => (f.path === 'Notes/secret.md' ? { frontmatter: { tags: ['private'] } } : {}) as never);
		await plugin.writePrivateRules(false);
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny).toEqual(['Read(/Notes/secret.md)', 'Edit(/Notes/secret.md)']);
		plugin.pro = proStub(false);
		expect(plugin.taggedFiles()).toEqual([]);
	});

	it('runs the self-test with Pro only', async () => {
		const { plugin, notices } = await setup();
		expect(await plugin.runSelfTest()).toBeNull();
		expect(notices.join(' ')).toMatch(/Pro is needed/);
		plugin.pro = proStub(true);
		await plugin.addPrivateFolder('Journal');
		const lines = await plugin.runSelfTest();
		expect(lines).toContain('1 files are inside the private set.');
		expect(lines).toContain('.claude/settings.json covers every private path.');
	});

	it('copies one line for agents without a deny list', async () => {
		const { plugin } = await setup();
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await plugin.copySnippet();
		expect(writeText).not.toHaveBeenCalled();
		plugin.settings.privateFolders = ['Journal'];
		await plugin.copySnippet();
		expect(writeText).toHaveBeenCalledWith('Do not read, search, quote or edit these private paths in this vault. Journal/');
	});
});

describe('rule files', () => {
	it('indexes the rule files', async () => {
		const { plugin } = await setup();
		expect(plugin.ruleFiles.map(f => f.path).sort()).toEqual(['AGENTS.md', 'Projects/AGENTS.md', 'Projects/App/CLAUDE.md']);
	});

	it('creates a rule file from the free template and never replaces a file', async () => {
		const { plugin, app, notices } = await setup();
		const f = await plugin.createRuleFile('Journal', 'AGENTS.md', 'basic');
		expect(f?.path).toBe('Journal/AGENTS.md');
		expect(await app.vault.read(app.vault.getFileByPath('Journal/AGENTS.md')!)).toContain('# Rules for agents in this folder');
		await plugin.createRuleFile('', 'AGENTS.md', 'basic');
		expect(await app.vault.read(app.vault.getFileByPath('AGENTS.md')!)).toBe(base['AGENTS.md']);
		expect(notices.join(' ')).toMatch(/already exists/);
		expect(await plugin.createRuleFile('Nope', 'AGENTS.md', 'basic')).toBeNull();
	});

	it('keeps the template pack for Pro', async () => {
		const { plugin, app } = await setup();
		expect(await plugin.createRuleFile('Journal', 'CLAUDE.md', 'research')).toBeNull();
		expect(app.vault.getFileByPath('Journal/CLAUDE.md')).toBeNull();
		plugin.pro = proStub(true);
		expect((await plugin.createRuleFile('Journal', 'CLAUDE.md', 'research'))?.path).toBe('Journal/CLAUDE.md');
	});

	it('writes a CLAUDE.md import, asks before it replaces a hand-edited file, and keeps a backup', async () => {
		const { plugin, app } = await setup({ ...base, 'Projects/App/AGENTS.md': '- x' });
		expect(await plugin.writeImportFile('Projects', 'CLAUDE.md')).toBe('created');
		expect(await app.vault.read(app.vault.getFileByPath('Projects/CLAUDE.md')!)).toBe(mirrorContent('CLAUDE.md'));
		expect(await plugin.writeImportFile('Projects', 'CLAUDE.md')).toBe('in-step');
		const no = vi.fn(async () => false);
		expect(await plugin.writeImportFile('Projects/App', 'CLAUDE.md', no)).toBe('kept');
		expect(no).toHaveBeenCalledOnce();
		expect(await app.vault.read(app.vault.getFileByPath('Projects/App/CLAUDE.md')!)).toBe('# My own Claude rules\n');
		expect(await plugin.writeImportFile('Projects/App', 'CLAUDE.md', async () => true)).toBe('replaced');
		expect(await app.vault.read(app.vault.getFileByPath('Projects/App/CLAUDE.md')!)).toBe(mirrorContent('CLAUDE.md'));
		const list = await app.vault.adapter.list('.agent-rules-backup/Projects/App');
		expect(list.files).toHaveLength(1);
		expect(await app.vault.adapter.read(list.files[0]!)).toBe('# My own Claude rules\n');
		expect(await plugin.writeImportFile('Journal', 'GEMINI.md')).toBe('no-agents');
	});

	it('lints with Pro only and finds dead links and duplicates', async () => {
		const { plugin } = await setup();
		expect(await plugin.runLint()).toBeNull();
		plugin.pro = proStub(true);
		vi.spyOn(plugin, 'activateView').mockResolvedValue(null);
		const r = await plugin.runLint();
		expect(r!.reports.find(x => x.path === 'Projects/AGENTS.md')!.dead.map(d => d.resolved)).toEqual(['Projects/docs/missing.md']);
		expect(r!.duplicates).toHaveLength(1);
		expect(r!.duplicates[0]!.places.map(p => p.path)).toEqual(['AGENTS.md', 'Projects/AGENTS.md']);
	});

	it('rebuilds the index for 10,000 notes with 200 rule files in under 500 ms', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 10000; i++) files[`Area ${i % 40}/Topic ${i % 300}/Note ${i}.md`] = '';
		for (let i = 0; i < 200; i++) files[`Area ${i % 40}/Topic ${i}/${['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'][i % 3]}`] = '- rule';
		const { plugin } = await setup(files);
		const t = performance.now();
		plugin.rebuildIndex();
		const ms = performance.now() - t;
		expect(plugin.ruleFiles).toHaveLength(200);
		expect(ms).toBeLessThan(500);
	});
});

describe('side view', () => {
	it('renders private folders first, the tree, and the rules for a folder', async () => {
		const { plugin, app } = await setup();
		plugin.settings.privateFolders = ['Journal'];
		const leaf = app.workspace.getLeaf(true);
		const view = new AgentRulesView(leaf as never, plugin);
		view.render();
		const el = view.contentEl;
		const heads = [...el.querySelectorAll('h4')].map(h => h.textContent);
		expect(heads).toEqual(['Private folders', 'Rule files (3)']);
		expect(el.textContent).toContain('Journal/');
		expect(el.textContent).toContain('A shell command can still read a file.');
		expect(el.textContent).toContain('Check (Pro)');
		view.selectFolder('Projects/App/src');
		expect(el.textContent).toContain('Rules for Projects/App/src/');
		const links = [...el.querySelectorAll('.agent-rules-applied a')].map(a => a.textContent);
		expect(links).toEqual(['AGENTS.md', 'Projects/AGENTS.md', 'Projects/App/CLAUDE.md']);
		expect(view.getViewType()).toBe(VIEW_TYPE);
	});

	it('shows an empty state with no rule files', async () => {
		const { plugin, app } = await setup({ 'a.md': '' });
		const view = new AgentRulesView(app.workspace.getLeaf(true) as never, plugin);
		view.render();
		expect(view.contentEl.textContent).toContain('No AGENTS.md, CLAUDE.md or GEMINI.md in this vault yet.');
	});

	it('loads and unloads the plugin', async () => {
		const app = App.createConfigured__({ files: base });
		const plugin = new AgentRulesPlugin(app as never, manifest as never);
		await plugin.onload();
		plugin.rebuildIndex();
		expect(plugin.ruleFiles).toHaveLength(3);
		plugin.onunload();
	});
});

describe('review fixes in the plugin', () => {
	it('keeps the rule of a deleted private folder and marks it as missing', async () => {
		const { app, plugin, read } = await setup();
		await plugin.addPrivateFolder('Journal');
		await app.vault.delete(app.vault.getFolderByPath('Journal')!, true);
		await plugin.writePrivateRules(false);
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny).toContain('Read(/Journal/**)');
		const view = new AgentRulesView(app.workspace.getLeaf(true) as never, plugin);
		view.render();
		expect(view.contentEl.textContent).toContain('(missing, the rule stays)');
	});

	it('moves a nested private folder when its parent is renamed', async () => {
		const { app, plugin, read, notices } = await setup({ ...base, 'Life/Health/a.md': 'x' });
		await plugin.addPrivateFolder('Life/Health');
		await plugin.movePrivateFolder('Life', 'Personal');
		expect(plugin.settings.privateFolders).toEqual(['Personal/Health']);
		const deny = JSON.parse((await read('.claude/settings.json'))!).permissions.deny;
		expect(deny).toEqual(['Read(/Personal/Health/**)', 'Edit(/Personal/Health/**)']);
		expect(notices.join(' ')).toMatch(/moved the private folder Life to Personal/);
		await plugin.movePrivateFolder('Other', 'X');
		expect(plugin.settings.privateFolders).toEqual(['Personal/Health']);
		void app;
	});

	it('gives a notice when an ignore file cannot be written', async () => {
		const { plugin, notices, adapter } = await setup(base, true);
		plugin.settings.cursorTarget = true;
		const orig = adapter.write.bind(adapter);
		vi.spyOn(adapter, 'write').mockImplementation(async (p: string, d: string) => { if (p === '.cursorignore') throw new Error('EACCES'); return orig(p, d); });
		await plugin.addPrivateFolder('Journal');
		expect(notices.join(' ')).toContain('Agent Rules could not write .cursorignore. The plugin did not change it.');
	});

	it('stops after 3 changed reads and writes nothing', async () => {
		const { plugin, adapter, notices } = await setup({ ...base, '.claude/settings.json': '{}' });
		let n = 0;
		vi.spyOn(adapter, 'read').mockImplementation(async () => `{"n": ${n++}}`);
		const write = vi.spyOn(adapter, 'write');
		await plugin.addPrivateFolder('Journal');
		expect(write).not.toHaveBeenCalled();
		expect(notices.join(' ')).toMatch(/changed while Agent Rules wrote it/);
	});

	it('shows one notice when Pro lapses and keeps the ignore file', async () => {
		const { plugin, read, notices } = await setup(base, true);
		plugin.settings.cursorTarget = true;
		await plugin.addPrivateFolder('Journal');
		plugin.pro = proStub(false);
		await plugin.addPrivateFolder('Notes');
		await plugin.writePrivateRules(false);
		expect(await read('.cursorignore')).toContain('/Journal/');
		expect(notices.filter(n => n.startsWith('Pro is off')).length).toBe(1);
	});

	it('rewrites tag rules when a tagged note changes, with Pro only', async () => {
		const { plugin, read } = await setup(base, true);
		plugin.settings.privateTags = ['private'];
		let tagged = new Set(['Notes/secret.md']);
		vi.spyOn(plugin.app.metadataCache, 'getFileCache').mockImplementation(f => (tagged.has(f.path) ? { frontmatter: { tags: ['private'] } } : {}) as never);
		await plugin.refreshTagRules();
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny).toContain('Read(/Notes/secret.md)');
		tagged = new Set(['Notes/open.md']);
		await plugin.refreshTagRules();
		const deny = JSON.parse((await read('.claude/settings.json'))!).permissions.deny;
		expect(deny).toEqual(['Read(/Notes/open.md)', 'Edit(/Notes/open.md)']);
		plugin.pro = proStub(false);
		tagged = new Set();
		await plugin.refreshTagRules();
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny).toEqual(deny);
	});
});
