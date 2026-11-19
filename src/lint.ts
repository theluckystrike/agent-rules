// Pure lint checks for rule files. No Obsidian imports.
//
// Length guide. Source, read 19 Nov 2026: https://code.claude.com/docs/en/memory
// "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."

export const MAX_LINES = 200;
/** ESTIMATE method: about 4 characters per token for English text. It is not a real tokenizer. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
	if (text === '') return 0;
	const n = text.split('\n').length;
	return text.endsWith('\n') ? n - 1 : n;
}

export interface LinkRef {
	kind: 'import' | 'markdown' | 'wiki';
	target: string;
	line: number;
}

/** Drops fenced code blocks and inline code spans, and keeps the line count. */
export function stripCode(text: string): string[] {
	const out: string[] = [];
	let fence: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(`{3,}|~{3,})/.exec(raw);
		if (m) {
			if (fence === null) fence = m[1]![0]!;
			else if (m[1]![0] === fence) fence = null;
			out.push('');
			continue;
		}
		out.push(fence === null ? raw.replace(/`[^`]*`/g, '') : '');
	}
	return out;
}

/** Finds @imports, Markdown links and wikilinks outside code. External URLs are skipped. */
export function findLinks(text: string): LinkRef[] {
	const refs: LinkRef[] = [];
	stripCode(text).forEach((line, i) => {
		for (const m of line.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
			const target = m[1]!.replace(/\\ /g, ' ').replace(/[.,;:)]+$/, '');
			// An import names a path, so it has a slash or a dot. A bare @name is a mention.
			if (target.includes('/') || target.includes('.')) refs.push({ kind: 'import', target, line: i + 1 });
		}
		for (const m of line.matchAll(/(^|[^!])\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			const target = m[2]!;
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
			refs.push({ kind: 'markdown', target: safeDecode(target.split('#')[0]!), line: i + 1 });
		}
		for (const m of line.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
			refs.push({ kind: 'wiki', target: m[1]!.trim(), line: i + 1 });
		}
	});
	return refs;
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Resolves a relative link against the folder of the rule file. Returns null when the path leaves the vault. */
export function resolveRelative(folder: string, target: string): string | null {
	if (target.startsWith('~') || target.startsWith('//')) return null;
	const parts = target.startsWith('/') ? [] : folder ? folder.split('/') : [];
	for (const seg of target.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join('/');
}

export interface DeadLink extends LinkRef {
	resolved: string | null;
}

/**
 * Lists the links that point to no file.
 * `exists` answers for vault paths. `resolveWiki` answers for wikilinks the way Obsidian resolves them.
 * Paths outside the vault are not checked and are not reported.
 */
export function deadLinks(text: string, folder: string, exists: (path: string) => boolean, resolveWiki: (link: string) => boolean): DeadLink[] {
	const out: DeadLink[] = [];
	for (const ref of findLinks(text)) {
		if (ref.kind === 'wiki') {
			if (!resolveWiki(ref.target)) out.push({ ...ref, resolved: null });
			continue;
		}
		const resolved = resolveRelative(folder, ref.target);
		if (resolved === null) continue;
		if (!exists(resolved)) out.push({ ...ref, resolved });
	}
	return out;
}

/** Turns a rule line into a key for the duplicate check. Returns null for lines that are not rules. */
export function ruleKey(line: string): string | null {
	const t = line.trim();
	if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('@') || t.startsWith('|')) return null;
	const body = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
	const key = body.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/[.;:,]+$/, '').trim();
	return key.length >= 12 ? key : null;
}

export interface Duplicate {
	rule: string;
	places: { path: string; line: number }[];
}

/**
 * Finds the same rule in more than one place: twice in one file, or in files that an agent loads together.
 * One pass with a map, so the cost is O(total lines).
 */
export function duplicateRules(files: { path: string; text: string }[]): Duplicate[] {
	const seen = new Map<string, Duplicate>();
	for (const f of files) {
		stripCode(f.text).forEach((line, i) => {
			const key = ruleKey(line);
			if (!key) return;
			const d = seen.get(key);
			if (d) d.places.push({ path: f.path, line: i + 1 });
			else seen.set(key, { rule: line.trim(), places: [{ path: f.path, line: i + 1 }] });
		});
	}
	return [...seen.values()].filter(d => d.places.length > 1);
}

export interface LintReport {
	path: string;
	lines: number;
	tokens: number;
	long: boolean;
	dead: DeadLink[];
}

export function lintFile(path: string, folder: string, text: string, exists: (p: string) => boolean, resolveWiki: (l: string) => boolean): LintReport {
	const lines = countLines(text);
	return { path, lines, tokens: estimateTokens(text), long: lines > MAX_LINES, dead: deadLinks(text, folder, exists, resolveWiki) };
}

function dirOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** True when an agent that works in the deeper folder loads both files: same folder, or one folder is an ancestor. */
export function loadTogether(a: string, b: string): boolean {
	const fa = dirOf(a);
	const fb = dirOf(b);
	if (fa === fb) return true;
	const [short, long] = fa.length < fb.length ? [fa, fb] : [fb, fa];
	return short === '' || long.startsWith(short + '/');
}

/** Keeps only the duplicates that an agent sees at the same time. */
export function duplicatesLoadedTogether(files: { path: string; text: string }[]): Duplicate[] {
	const out: Duplicate[] = [];
	for (const d of duplicateRules(files)) {
		const keep = d.places.filter((p, i) => d.places.some((q, j) => i !== j && loadTogether(p.path, q.path)));
		if (keep.length > 1) out.push({ rule: d.rule, places: keep });
	}
	return out;
}
