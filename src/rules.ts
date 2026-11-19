// Pure logic for the rule file index. No Obsidian imports, so tests and vectors run in Node.

export const RULE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
export type RuleName = (typeof RULE_NAMES)[number];

/** The agents that read each file name. Used for labels in the side view. */
export const RULE_READERS: Record<RuleName, string> = {
	'AGENTS.md': 'Codex, Cursor and Claude Code',
	'CLAUDE.md': 'Claude Code',
	'GEMINI.md': 'Gemini CLI',
};

export interface RuleFile {
	path: string;
	folder: string;
	name: RuleName;
}

export interface RuleTreeNode {
	/** Folder path. The vault root is the empty string. */
	path: string;
	label: string;
	files: RuleFile[];
	children: RuleTreeNode[];
}

const NAME_SET = new Set<string>(RULE_NAMES);

export function folderOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function isRuleName(name: string): name is RuleName {
	return NAME_SET.has(name);
}

/** Picks the rule files from a list of vault paths. One pass, O(n). */
export function collectRuleFiles(paths: Iterable<string>): RuleFile[] {
	const out: RuleFile[] = [];
	for (const path of paths) {
		const name = baseName(path);
		if (isRuleName(name)) out.push({ path, folder: folderOf(path), name });
	}
	return out;
}

const nameRank = (n: RuleName): number => RULE_NAMES.indexOf(n);

/**
 * Builds a folder tree that holds only the rule files and their ancestor folders.
 * Cost is O(k x depth) for k rule files. Each folder node is made once, through a map.
 */
export function buildRuleTree(files: RuleFile[]): RuleTreeNode {
	const root: RuleTreeNode = { path: '', label: '/', files: [], children: [] };
	const nodes = new Map<string, RuleTreeNode>([['', root]]);
	const ensure = (folder: string): RuleTreeNode => {
		const found = nodes.get(folder);
		if (found) return found;
		const parent = ensure(folderOf(folder));
		const node: RuleTreeNode = { path: folder, label: baseName(folder), files: [], children: [] };
		nodes.set(folder, node);
		parent.children.push(node);
		return node;
	};
	for (const f of files) ensure(f.folder).files.push(f);
	for (const node of nodes.values()) {
		node.children.sort((a, b) => a.label.localeCompare(b.label));
		node.files.sort((a, b) => nameRank(a.name) - nameRank(b.name));
	}
	return root;
}

/** Counts the rule files in a tree. */
export function countTreeFiles(node: RuleTreeNode): number {
	let n = node.files.length;
	for (const c of node.children) n += countTreeFiles(c);
	return n;
}

export interface AppliedRule {
	name: RuleName;
	/** Rule files from the vault root down to the folder. The last one is the nearest. */
	chain: string[];
}

/**
 * Lists the rule files that apply to a folder: each file in the folder or in an ancestor folder.
 * Claude Code, Codex and Gemini CLI read the files on the path from the project root to the work folder.
 * The plugin assumes that the vault root is the project root.
 */
export function rulesForFolder(folder: string, byFolder: Map<string, RuleFile[]>): AppliedRule[] {
	const ancestors: string[] = [''];
	if (folder) {
		const parts = folder.split('/');
		for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
	}
	const out: AppliedRule[] = [];
	for (const name of RULE_NAMES) {
		const chain: string[] = [];
		for (const a of ancestors) for (const f of byFolder.get(a) ?? []) if (f.name === name) chain.push(f.path);
		if (chain.length) out.push({ name, chain });
	}
	return out;
}

export function indexByFolder(files: RuleFile[]): Map<string, RuleFile[]> {
	const map = new Map<string, RuleFile[]>();
	for (const f of files) {
		const list = map.get(f.folder);
		if (list) list.push(f);
		else map.set(f.folder, [f]);
	}
	return map;
}

export function joinPath(folder: string, name: string): string {
	return folder ? `${folder}/${name}` : name;
}
