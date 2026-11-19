// Pure logic for private folders. No Obsidian imports.
//
// Claude Code deny rules. Source, read 19 Nov 2026:
// https://code.claude.com/docs/en/permissions#read-and-edit
// "Read and Edit rules both use gitignore pattern syntax". A "/path" pattern is a
// "Path relative to the settings source", which for ".claude/settings.json" is the
// "<primary working directory>". Example from the docs: "Read(./secrets/**)".
// https://code.claude.com/docs/en/settings#edit-a-settings-file
// "Settings files are strict JSON: a // comment or a trailing comma is a syntax error".

import { RawNumber, parseLossless, stringifyLossless, type LJson } from './json';

export const SETTINGS_PATH = '.claude/settings.json';
export const CURSOR_IGNORE = '.cursorignore';
export const GEMINI_IGNORE = '.geminiignore';

export const BLOCK_BEGIN = '# BEGIN Agent Rules private folders (managed block, edits inside are replaced)';
export const BLOCK_END = '# END Agent Rules private folders';

/** Cleans a folder path from the user. Returns null for the vault root or a path that leaves the vault. */
export function cleanFolder(folder: string): string | null {
	const parts = folder.replace(/\\/g, '/').split('/').filter(p => p !== '' && p !== '.');
	if (!parts.length || parts.some(p => p === '..')) return null;
	return parts.join('/');
}

/** Escapes the gitignore pattern characters in a literal path. */
export function escapeGlob(path: string): string {
	return path.replace(/[\\*?[\]!#]/g, ch => `\\${ch}`);
}

/** The private set: whole folders, plus single notes (for example the notes with a private tag). */
export interface PrivateSet {
	folders: string[];
	files: string[];
}

/** The Claude Code deny rules for one private folder. */
export function denyRulesFor(folder: string): string[] {
	const clean = cleanFolder(folder);
	if (!clean) return [];
	const p = escapeGlob(clean);
	return [`Read(/${p}/**)`, `Edit(/${p}/**)`];
}

/** The Claude Code deny rules for one private note. */
export function denyRulesForFile(file: string): string[] {
	const clean = cleanFolder(file);
	if (!clean) return [];
	const p = escapeGlob(clean);
	return [`Read(/${p})`, `Edit(/${p})`];
}

export function denyRulesForAll(set: PrivateSet): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (r: string): void => { if (!seen.has(r)) { seen.add(r); out.push(r); } };
	for (const f of set.folders) for (const r of denyRulesFor(f)) add(r);
	for (const f of set.files) for (const r of denyRulesForFile(f)) add(r);
	return out;
}

export type MergeResult =
	| { ok: true; text: string; changed: boolean; rules: string[] }
	| { ok: false; error: string };

function isObject(v: unknown): v is Record<string, LJson> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

function detectIndent(text: string): string | number {
	const m = /\n([ \t]+)"/.exec(text);
	if (!m) return 2;
	return m[1]!.startsWith('\t') ? '\t' : m[1]!.length;
}

const BOM = '\uFEFF';

/**
 * Merges the deny rules for the private folders into the text of .claude/settings.json.
 * - Keeps every other key and every deny rule that the plugin did not write. Numbers keep their source text.
 * - Removes only the rules in `previous` (the rules that the plugin wrote the last time) that are no longer wanted.
 * - `rules` names the rules that the plugin owns now. A rule that was in the file before the plugin added it is not owned.
 * - Refuses a file that is not strict JSON, or whose permissions or deny value has the wrong type. It then writes nothing.
 * - Keeps a byte order mark at the start of the file.
 * - The same input gives the same output, so a second run makes no change.
 */
export function mergeClaudeSettings(existing: string | null, set: PrivateSet, previous: string[] = []): MergeResult {
	const wanted = denyRulesForAll(set);
	const bom = existing !== null && existing.startsWith(BOM) ? BOM : '';
	const body = existing === null ? null : existing.slice(bom.length);
	let data: Record<string, LJson>;
	if (body === null || body.trim() === '') {
		data = {};
	} else {
		try {
			JSON.parse(body);
		} catch {
			return { ok: false, error: `${SETTINGS_PATH} is not valid JSON. Fix the file, then try again. The plugin did not change it.` };
		}
		const parsed = parseLossless(body);
		if (!isObject(parsed)) return { ok: false, error: `${SETTINGS_PATH} does not hold a JSON object. The plugin did not change it.` };
		data = parsed;
	}
	const permissions = data.permissions;
	if (permissions !== undefined && !isObject(permissions)) {
		return { ok: false, error: `The permissions value in ${SETTINGS_PATH} is not an object. The plugin did not change it.` };
	}
	const deny = permissions?.deny;
	if (deny !== undefined && (!Array.isArray(deny) || deny.some(r => typeof r !== 'string'))) {
		return { ok: false, error: `The permissions.deny value in ${SETTINGS_PATH} is not a list of text rules. The plugin did not change it.` };
	}
	const current = (deny ?? []) as string[];
	const wantedSet = new Set(wanted);
	const currentSet = new Set(current);
	const prevSet = new Set(previous);
	const rules = wanted.filter(r => !currentSet.has(r) || prevSet.has(r));
	const next = current.filter(r => wantedSet.has(r) || !prevSet.has(r));
	const have = new Set(next);
	for (const r of wanted) if (!have.has(r)) { have.add(r); next.push(r); }

	const same = next.length === current.length && next.every((r, i) => r === current[i]);
	if (same && body !== null && body.trim() !== '') {
		return { ok: true, text: existing!, changed: false, rules };
	}
	if (same && next.length === 0) {
		// Nothing to write and no file: keep it absent.
		return { ok: true, text: existing ?? '', changed: false, rules };
	}
	const perms: Record<string, LJson> = permissions ? { ...permissions } : {};
	if (next.length) perms.deny = next;
	else delete perms.deny;
	const out: Record<string, LJson> = { ...data };
	if (Object.keys(perms).length || permissions) out.permissions = perms;
	const text = bom + stringifyLossless(out, body ? detectIndent(body) : 2) + '\n';
	return { ok: true, text, changed: text !== existing, rules };
}

/** The lines of the ignore block for .cursorignore and .geminiignore. A leading slash anchors at the vault root. */
export function ignoreLinesFor(set: PrivateSet): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (path: string, dir: boolean): void => {
		const clean = cleanFolder(path);
		if (!clean) return;
		const line = `/${escapeGlob(clean)}${dir ? '/' : ''}`;
		if (!seen.has(line)) { seen.add(line); out.push(line); }
	};
	for (const f of set.folders) add(f, true);
	for (const f of set.files) add(f, false);
	return out;
}

export type BlockResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

/**
 * Writes the private folders into a marked block of an ignore file.
 * Lines outside the block stay as they are. An empty folder list removes the block.
 */
export function mergeIgnoreBlock(existing: string | null, set: PrivateSet, fileName: string): BlockResult {
	const text = existing ?? '';
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text === '' ? [] : text.split(/\r?\n/);
	const begins: number[] = [];
	const ends: number[] = [];
	lines.forEach((l, i) => { const t = l.trim(); if (t === BLOCK_BEGIN) begins.push(i); else if (t === BLOCK_END) ends.push(i); });
	if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length || (begins.length === 1 && ends[0]! < begins[0]!)) {
		return { ok: false, error: `The Agent Rules block in ${fileName} is broken. Fix or remove the block, then try again. The plugin did not change the file.` };
	}
	const body = ignoreLinesFor(set);
	const block = body.length ? [BLOCK_BEGIN, ...body, BLOCK_END] : [];
	let next: string[];
	if (begins.length === 1) {
		next = [...lines.slice(0, begins[0]), ...block, ...lines.slice(ends[0]! + 1)];
	} else {
		if (!block.length) return { ok: true, text, changed: false };
		const head = [...lines];
		while (head.length && head[head.length - 1] === '') head.pop();
		next = head.length ? [...head, '', ...block] : block;
	}
	while (next.length && next[next.length - 1] === '') next.pop();
	const out = next.length ? next.join(eol) + eol : '';
	return { ok: true, text: out, changed: out !== text };
}

/** Tells if a vault path is inside the private set. */
export function isCovered(path: string, set: PrivateSet): boolean {
	for (const f of set.folders) {
		const c = cleanFolder(f);
		if (c && (path === c || path.startsWith(c + '/'))) return true;
	}
	return set.files.includes(path);
}

/** Counts the vault paths inside the private set. One pass over the paths. */
export function countCovered(paths: Iterable<string>, set: PrivateSet): number {
	const folders = set.folders.map(cleanFolder).filter((f): f is string => !!f).map(f => f + '/');
	const files = new Set(set.files);
	let n = 0;
	for (const p of paths) if (files.has(p) || folders.some(f => p.startsWith(f))) n++;
	return n;
}

export interface SelfTestRow {
	target: string;
	ok: boolean;
	missing: string[];
	note: string;
}

/**
 * Reads back the written files and checks that each wanted rule or line is there.
 * Pass null for a target that is turned off.
 */
export function selfTest(set: PrivateSet, claude: string | null, cursor: string | null | undefined, gemini: string | null | undefined): SelfTestRow[] {
	const rows: SelfTestRow[] = [];
	const wanted = denyRulesForAll(set);
	let deny: string[] = [];
	let note = '';
	if (claude === null) note = 'The file is missing.';
	else {
		try {
			const parsed = JSON.parse(claude.replace(/^\uFEFF/, '')) as { permissions?: { deny?: unknown } };
			const d = parsed?.permissions?.deny;
			deny = Array.isArray(d) ? d.filter((r): r is string => typeof r === 'string') : [];
		} catch {
			note = 'The file is not valid JSON.';
		}
	}
	const denySet = new Set(deny);
	const missing = wanted.filter(r => !denySet.has(r));
	rows.push({ target: SETTINGS_PATH, ok: !note && missing.length === 0, missing, note });
	const lines = ignoreLinesFor(set);
	const check = (name: string, text: string | null | undefined): void => {
		if (text === undefined) return;
		if (text === null) { rows.push({ target: name, ok: lines.length === 0, missing: lines, note: 'The file is missing.' }); return; }
		const all = text.split(/\r?\n/);
		const b = all.findIndex(l => l.trim() === BLOCK_BEGIN);
		const e = all.findIndex(l => l.trim() === BLOCK_END);
		const block = new Set(b >= 0 && e > b ? all.slice(b + 1, e).map(l => l.trim()) : []);
		const miss = lines.filter(l => !block.has(l));
		rows.push({ target: name, ok: miss.length === 0, missing: miss, note: b < 0 && lines.length ? 'The managed block is missing.' : '' });
	};
	check(CURSOR_IGNORE, cursor);
	check(GEMINI_IGNORE, gemini);
	return rows;
}

/** A line for a host that has no deny list, such as the Copilot plugin. The user pastes it into the host instructions. */
export function instructionSnippet(set: PrivateSet): string {
	const names = [...set.folders.map(cleanFolder).filter((f): f is string => !!f).map(f => `${f}/`), ...set.files];
	if (!names.length) return '';
	return `Do not read, search, quote or edit these private paths in this vault. ${names.join(', ')}`;
}
