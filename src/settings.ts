import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { helloSettingItems } from './hello/settings';
import type AgentRulesPlugin from './main';
import { PRO_UI } from './pro';
import { TEMPLATES } from './templates';

export interface AgentRulesSettings {
	privateFolders: string[];
	/** Pro. Notes with one of these tags are private too. Tags without the # sign. */
	privateTags: string[];
	/** The deny rules that the plugin wrote the last time. Only these rules are ever removed. */
	managedDeny: string[];
	/** The tagged notes that the last Pro write covered. They stay private when Pro lapses. */
	frozenTagFiles: string[];
	/** Pro. Write .cursorignore. */
	cursorTarget: boolean;
	/** Pro. Write .geminiignore. */
	geminiTarget: boolean;
	templateId: string;
}

export const DEFAULT_SETTINGS: AgentRulesSettings = {
	privateFolders: [],
	privateTags: [],
	managedDeny: [],
	frozenTagFiles: [],
	cursorTarget: false,
	geminiTarget: false,
	templateId: 'basic',
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<AgentRulesSettings> | null | undefined): AgentRulesSettings {
	const s = (saved ?? {}) as Record<string, unknown>;
	return {
		privateFolders: [...new Set(strings(s.privateFolders))],
		privateTags: [...new Set(strings(s.privateTags).map(t => t.replace(/^#/, '')))],
		managedDeny: strings(s.managedDeny),
		frozenTagFiles: strings(s.frozenTagFiles),
		cursorTarget: s.cursorTarget === true,
		geminiTarget: s.geminiTarget === true,
		templateId: typeof s.templateId === 'string' && TEMPLATES.some(t => t.id === s.templateId) ? s.templateId : DEFAULT_SETTINGS.templateId,
	};
}

export class AgentRulesSettingTab extends PluginSettingTab {
	declare plugin: AgentRulesPlugin;

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		const p = this.plugin;
		const s = p.settings;
		return [
			{ name: 'Private folders for agents', desc: 'Coding agents must not read or edit these folders. Claude Code reads the deny rules in .claude/settings.json. A shell command or a script can still read a file.' },
			{
				type: 'list',
				heading: 'Private folders',
				emptyState: 'No private folders yet.',
				items: s.privateFolders.map(f => ({ name: f || '/' })),
				onDelete: (i: number) => { void p.removePrivateFolder(s.privateFolders[i] ?? ''); },
				addItem: { name: 'Add folder', action: () => p.pickPrivateFolder() },
			},
			{ name: 'Write the rules now', desc: 'Write the deny rules for the private folders. The plugin keeps every other setting in the file.', action: () => { void p.writePrivateRules(true); } },
			{ name: 'Copy a line for other agents', desc: 'Copy one instruction line that names the private folders. Paste it into the instructions of an agent that has no deny list, such as the Copilot plugin.', action: () => { void p.copySnippet(); } },
			{ type: 'group', heading: 'Pro', items: [
				{ name: 'Private tags', desc: 'Notes with one of these tags are private too. Separate tags with commas. Pro', control: { type: 'text', key: 'privateTagsText', defaultValue: '' } },
				{ name: 'Cursor ignore file', desc: 'Also write the private folders into .cursorignore. Pro', control: { type: 'toggle', key: 'cursorTarget', defaultValue: false } },
				{ name: 'Gemini ignore file', desc: 'Also write the private folders into .geminiignore. Pro', control: { type: 'toggle', key: 'geminiTarget', defaultValue: false } },
				{ name: 'Template for new rule files', desc: 'The basic template is free. The other templates are Pro.', control: { type: 'dropdown', key: 'templateId', options: Object.fromEntries(TEMPLATES.map(t => [t.id, t.pro ? `${t.name} (Pro)` : t.name])), defaultValue: 'basic' } },
				{ name: 'Check the written rules', desc: 'Read the files back and show which private paths each agent file covers. Pro', action: () => { void p.runSelfTest(); } },
			] },
			...sponsorsSettingItems(p.pro!, PRO_UI),
		];
	}

	getControlValue(key: string): unknown {
		if (key === 'privateTagsText') return this.plugin.settings.privateTags.join(', ');
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.plugin.setSetting(key, value);
	}
}
