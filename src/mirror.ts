// Pure logic for mirror files. No Obsidian imports.
//
// Claude Code import syntax. Source, read 19 Nov 2026:
// https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools
// "you can still keep it as the one file every tool shares by putting an `@AGENTS.md` import in a `CLAUDE.md` next to it."
// https://code.claude.com/docs/en/memory#import-additional-files
// "Relative paths resolve relative to the file containing the import, not the working directory."
//
// Gemini CLI import syntax. Source, read 19 Nov 2026:
// https://geminicli.com/docs/reference/memport/
// "Use the @ symbol followed by the path to the file you want to import", with `@./file.md` for the same folder.

export type MirrorTarget = 'CLAUDE.md' | 'GEMINI.md';

export const MIRROR_MARK = '<!-- Agent Rules mirror. Edit AGENTS.md in this folder. This file only imports it. -->';

export function mirrorContent(target: MirrorTarget): string {
	const line = target === 'CLAUDE.md' ? '@AGENTS.md' : '@./AGENTS.md';
	return `${MIRROR_MARK}\n${line}\n`;
}

export type MirrorState = 'missing' | 'in-step' | 'hand-edited';

/** Tells if a target file is absent, already the mirror, or a file that a person wrote. */
export function mirrorState(target: MirrorTarget, existing: string | null): MirrorState {
	if (existing === null) return 'missing';
	return existing.replace(/\r\n/g, '\n').trim() === mirrorContent(target).trim() ? 'in-step' : 'hand-edited';
}

export interface MirrorPlanItem {
	folder: string;
	target: MirrorTarget;
	path: string;
	state: MirrorState;
}

/** A backup path inside the hidden folder .agent-rules-backup, with a time stamp. */
export function backupPath(path: string, now: Date): string {
	const p = (n: number): string => String(n).padStart(2, '0');
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	return `.agent-rules-backup/${path}.${stamp}.bak`;
}
