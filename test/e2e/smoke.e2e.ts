import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';

interface RulesPlugin {
	addPrivateFolder(path: string): Promise<void>;
	removePrivateFolder(path: string): Promise<void>;
	activateView(): Promise<unknown>;
	showFolder(folder: string): Promise<void>;
	rebuildIndex(): void;
	settings: { privateFolders: string[] };
}

/** Text of the side view, or "" when the view is not open. */
async function viewText(): Promise<string> {
	return browser.execute(() => document.querySelector('.agent-rules-view')?.textContent ?? '');
}

/** The deny list in .claude/settings.json, or null when the file does not exist. */
async function denyRules(): Promise<string[] | null> {
	return browser.executeObsidian(async ({ app }) => {
		if (!(await app.vault.adapter.exists('.claude/settings.json'))) return null;
		const json = JSON.parse(await app.vault.adapter.read('.claude/settings.json')) as { permissions?: { deny?: string[] } };
		return json.permissions?.deny ?? [];
	});
}

describe(`${pluginId} smoke test`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const state = await reloadPlugin(pluginId);
		expect(state).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('writes Claude Code deny rules for a private folder and keeps other keys', async function () {
		await obsidianPage.write('Journal/Day.md', 'private');
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.adapter.mkdir('.claude');
			await app.vault.adapter.write('.claude/settings.json', JSON.stringify({ model: 'opus', permissions: { deny: ['Bash(rm:*)'] } }, null, 2));
		});
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, RulesPlugin> } }).plugins.plugins[id]!;
			await p.activateView();
			await p.addPrivateFolder('Journal');
		}, pluginId);
		await browser.waitUntil(async () => ((await denyRules()) ?? []).includes('Read(/Journal/**)'), { timeout: 5000 });
		expect(await denyRules()).toEqual(['Bash(rm:*)', 'Read(/Journal/**)', 'Edit(/Journal/**)']);
		const model = await browser.executeObsidian(async ({ app }) => (JSON.parse(await app.vault.adapter.read('.claude/settings.json')) as { model?: string }).model);
		expect(model).toBe('opus');
		await browser.waitUntil(async () => (await viewText()).includes('Journal/'), { timeout: 5000 });
	});

	it('removes only its own rules when the folder is no longer private', async function () {
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, RulesPlugin> } }).plugins.plugins[id]!;
			await p.removePrivateFolder('Journal');
		}, pluginId);
		expect(await denyRules()).toEqual(['Bash(rm:*)']);
	});

	it('shows the rule file tree and the nearest rules for a folder', async function () {
		await obsidianPage.write('AGENTS.md', '# Root rules');
		await obsidianPage.write('Projects/AGENTS.md', '# Project rules');
		await obsidianPage.write('Projects/Site/CLAUDE.md', '@AGENTS.md');
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, RulesPlugin> } }).plugins.plugins[id]!;
			await new Promise((r) => setTimeout(r, 600));
			p.rebuildIndex();
			await p.showFolder('Projects/Site');
		}, pluginId);
		await browser.waitUntil(async () => (await viewText()).includes('Rules for Projects/Site/'), { timeout: 5000 });
		const chains = await browser.execute(() => Array.from(document.querySelectorAll('.agent-rules-applied ol')).map((ol) => Array.from(ol.querySelectorAll('li')).map((li) => li.textContent ?? '')));
		expect(chains).toEqual([['AGENTS.md', 'Projects/AGENTS.md'], ['Projects/Site/CLAUDE.md']]);
		const files = await browser.execute(() => document.querySelectorAll('.agent-rules-view .agent-rules-file').length);
		expect(files).toBe(3);
	});
});
