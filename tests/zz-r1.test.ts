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


// R1-B1 refutation tests. Each test states the SAFE behavior. A failure is a finding.
describe('R1 refute', () => {
	it('R-a rename of a private folder keeps it private', async () => {
		const { app, plugin, read } = await setup();
		await plugin.addPrivateFolder('Journal');
		const folder = app.vault.getFolderByPath('Journal')!;
		await app.vault.rename(folder, 'Diary');
		await new Promise(r => setTimeout(r, 400));
		await plugin.writePrivateRules(false);
		const deny = JSON.parse((await read('.claude/settings.json'))!).permissions.deny;
		expect(plugin.settings.privateFolders).toContain('Diary');
		expect(deny).toContain('Read(/Diary/**)');
	});

	it('R-b a read-only settings file gives a notice and keeps state in step', async () => {
		const { plugin, notices, adapter } = await setup({ ...base, '.claude/settings.json': '{}\n' });
		const orig = adapter.write.bind(adapter);
		vi.spyOn(adapter, 'write').mockImplementation(async (p: string, d: string) => { if (p === '.claude/settings.json') throw new Error('EACCES: permission denied'); return orig(p, d); });
		let threw = false;
		try { await plugin.addPrivateFolder('Journal'); } catch { threw = true; }
		expect({ threw, folders: plugin.settings.privateFolders, managed: plugin.settings.managedDeny }).toEqual({ threw: false, folders: ['Journal'], managed: [] });
		expect(notices.join(' ')).toMatch(/could not|cannot|permission|did not/i);
	});

	it('R-c a hand edit between read and write is not lost', async () => {
		const { plugin, adapter, read } = await setup({ ...base, '.claude/settings.json': '{"model":"opus"}\n' });
		const origRead = adapter.read.bind(adapter);
		let once = true;
		vi.spyOn(adapter, 'read').mockImplementation(async (p: string) => {
			const t = await origRead(p);
			if (p === '.claude/settings.json' && once) { once = false; await adapter.write(p, '{"model":"opus","env":{"A":"1"}}\n'); }
			return t;
		});
		await plugin.addPrivateFolder('Journal');
		const after = JSON.parse((await read('.claude/settings.json'))!);
		expect(after.env).toEqual({ A: '1' });
	});

	it('R-d a large integer in another key keeps its value', async () => {
		const { plugin, read } = await setup({ ...base, '.claude/settings.json': '{"cleanupPeriodDays": 12345678901234567890}\n' });
		await plugin.addPrivateFolder('Journal');
		expect(await read('.claude/settings.json')).toContain('12345678901234567890');
	});

	it('R-e a BOM file is refused or kept with its BOM', async () => {
		const { plugin, read } = await setup({ ...base, '.claude/settings.json': '﻿{"model":"opus"}\n' });
		await plugin.addPrivateFolder('Journal');
		const t = (await read('.claude/settings.json'))!;
		expect(t === '﻿{"model":"opus"}\n' || t.startsWith('﻿')).toBe(true);
	});

	it('R-f a lapsed Pro keeps the written tag rules and ignore block', async () => {
		const { plugin, read } = await setup({ ...base, '.cursorignore': 'node_modules/\n' }, true);
		plugin.settings.privateTags = ['private'];
		plugin.settings.cursorTarget = true;
		vi.spyOn(plugin.app.metadataCache, 'getFileCache').mockImplementation(f => (f.path === 'Notes/secret.md' ? { frontmatter: { tags: ['private'] } } : {}) as never);
		await plugin.writePrivateRules(false);
		plugin.pro = proStub(false);
		await plugin.addPrivateFolder('Journal');
		const deny = JSON.parse((await read('.claude/settings.json'))!).permissions.deny;
		expect(deny).toContain('Read(/Notes/secret.md)');
		expect(await read('.cursorignore')).toContain('/Notes/secret.md');
	});

	it('R-g a renamed tagged note is covered without a manual write', async () => {
		const { app, plugin, read } = await setup(base, true);
		plugin.settings.privateTags = ['private'];
		vi.spyOn(plugin.app.metadataCache, 'getFileCache').mockImplementation(f => (f.path.endsWith('secret.md') || f.path.endsWith('moved.md') ? { frontmatter: { tags: ['private'] } } : {}) as never);
		await plugin.writePrivateRules(false);
		await app.vault.rename(app.vault.getFileByPath('Notes/secret.md')!, 'Notes/moved.md');
		await new Promise(r => setTimeout(r, 400));
		const deny = JSON.parse((await read('.claude/settings.json'))!).permissions.deny;
		expect(deny).toContain('Read(/Notes/moved.md)');
	});

	it('R-h ignore block keeps user lines, is idempotent, removes clean', async () => {
		const orig = '# mine\r\nnode_modules/\r\n\r\n*.log\r\n';
		const { plugin, read } = await setup({ ...base, '.cursorignore': orig }, true);
		plugin.settings.cursorTarget = true;
		await plugin.addPrivateFolder('Journal');
		const one = (await read('.cursorignore'))!;
		await plugin.writePrivateRules(false);
		expect(await read('.cursorignore')).toBe(one);
		expect(one.startsWith(orig)).toBe(true);
		await plugin.removePrivateFolder('Journal');
		expect(await read('.cursorignore')).toBe(orig);
	});

	it('R-i a user deny rule equal to a managed rule survives a folder removal', async () => {
		const { plugin, read } = await setup({ ...base, '.claude/settings.json': '{"permissions":{"deny":["Read(/Journal/**)"]}}\n' });
		await plugin.addPrivateFolder('Journal');
		await plugin.removePrivateFolder('Journal');
		expect(JSON.parse((await read('.claude/settings.json'))!).permissions.deny ?? []).toContain('Read(/Journal/**)');
	});
});
