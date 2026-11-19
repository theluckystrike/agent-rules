import { describe, expect, it } from 'vitest';
import vectors from './vectors/agent-rules.json';
import {
	BLOCK_BEGIN, BLOCK_END, cleanFolder, countCovered, denyRulesFor, escapeGlob, ignoreLinesFor, instructionSnippet,
	isCovered, mergeClaudeSettings, mergeIgnoreBlock, selfTest, type PrivateSet,
} from '../src/privacy';

const set = (folders: string[], files: string[] = []): PrivateSet => ({ folders, files });

describe('golden vectors for mergeClaudeSettings', () => {
	for (const c of vectors.cases) {
		it(c.name, () => expect(mergeClaudeSettings(c.args[0] as never, c.args[1] as never, c.args[2] as never)).toEqual(c.expected));
	}
});

describe('JSON merge of .claude/settings.json', () => {
	const team = JSON.stringify({
		$schema: 'https://json.schemastore.org/claude-code-settings.json',
		model: 'sonnet',
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
		permissions: { allow: ['Bash(npm test)'], ask: ['Bash(git push)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' },
		env: { A: '1' },
	}, null, 2) + '\n';

	it('keeps every other key and value', () => {
		const r = mergeClaudeSettings(team, set(['Journal']));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const before = JSON.parse(team) as Record<string, unknown>;
		const after = JSON.parse(r.text) as { permissions: Record<string, unknown> } & Record<string, unknown>;
		for (const k of Object.keys(before)) if (k !== 'permissions') expect(after[k]).toEqual(before[k]);
		expect(after.permissions.allow).toEqual(['Bash(npm test)']);
		expect(after.permissions.ask).toEqual(['Bash(git push)']);
		expect(after.permissions.defaultMode).toBe('acceptEdits');
		expect(after.permissions.deny).toEqual(['Read(./.env)', 'Read(/Journal/**)', 'Edit(/Journal/**)']);
		expect(Object.keys(after)).toEqual(Object.keys(before));
	});

	it('writes strict JSON with no comments', () => {
		const r = mergeClaudeSettings(team, set(['Journal']));
		if (!r.ok) throw new Error('refused');
		for (const line of r.text.split('\n')) expect(line.trim()).not.toMatch(/^(\/\/|\/\*)/);
		expect(r.text).not.toMatch(/,\s*[}\]]/);
		expect(() => JSON.parse(r.text) as unknown).not.toThrow();
	});

	it('is idempotent', () => {
		const first = mergeClaudeSettings(team, set(['Journal', 'Health']));
		if (!first.ok) throw new Error('refused');
		const second = mergeClaudeSettings(first.text, set(['Journal', 'Health']), first.rules);
		expect(second).toEqual({ ok: true, text: first.text, changed: false, rules: first.rules });
		const third = mergeClaudeSettings(first.text, set(['Health', 'Journal']), first.rules);
		if (!third.ok) throw new Error('refused');
		expect(new Set(JSON.parse(third.text).permissions.deny as string[])).toEqual(new Set(JSON.parse(first.text).permissions.deny as string[]));
	});

	it('refuses malformed files and gives a reason', () => {
		for (const bad of ['{ "a": 1, }', '{ // c\n "a": 1 }', '/* c */ {}', '[1,2]', '"text"', '{"permissions": []}', '{"permissions": {"deny": [1]}}', '{']) {
			const r = mergeClaudeSettings(bad, set(['A']));
			expect(r.ok, bad).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/did not change/);
		}
	});

	it('does not create a file when there is nothing to deny', () => {
		expect(mergeClaudeSettings(null, set([]))).toEqual({ ok: true, text: '', changed: false, rules: [] });
	});

	it('removes a folder rule only when the plugin wrote it', () => {
		const text = JSON.stringify({ permissions: { deny: ['Read(/A/**)', 'Edit(/A/**)'] } });
		const r = mergeClaudeSettings(text, set([]), []);
		expect(r.ok && r.changed).toBe(false);
		const r2 = mergeClaudeSettings(text, set([]), ['Read(/A/**)', 'Edit(/A/**)']);
		if (!r2.ok) throw new Error('refused');
		expect(JSON.parse(r2.text).permissions).toEqual({});
	});

	it('does not duplicate a rule that the user already wrote', () => {
		const text = JSON.stringify({ permissions: { deny: ['Read(/A/**)'] } });
		const r = mergeClaudeSettings(text, set(['A']));
		if (!r.ok) throw new Error('refused');
		expect(JSON.parse(r.text).permissions.deny).toEqual(['Read(/A/**)', 'Edit(/A/**)']);
	});

	it('treats a file of white space as empty', () => {
		const r = mergeClaudeSettings('  \n', set(['A']));
		expect(r.ok && r.changed).toBe(true);
	});
});

describe('paths and patterns', () => {
	it('cleans folders and refuses the root and parent paths', () => {
		expect(cleanFolder('/A//B/')).toBe('A/B');
		expect(cleanFolder('')).toBeNull();
		expect(cleanFolder('/')).toBeNull();
		expect(cleanFolder('A/../B')).toBeNull();
		expect(cleanFolder('A\\B')).toBe('A/B');
	});
	it('escapes gitignore characters', () => {
		expect(escapeGlob('a*b?[c]!#\\')).toBe('a\\*b\\?\\[c\\]\\!\\#\\\\');
		expect(denyRulesFor('My notes')).toEqual(['Read(/My notes/**)', 'Edit(/My notes/**)']);
		expect(denyRulesFor('')).toEqual([]);
	});
	it('anchors ignore lines at the vault root', () => {
		expect(ignoreLinesFor(set(['A', 'A', 'B/C'], ['N.md']))).toEqual(['/A/', '/B/C/', '/N.md']);
	});
	it('tells which paths are covered', () => {
		const s = set(['A'], ['B/x.md']);
		expect(isCovered('A/y.md', s)).toBe(true);
		expect(isCovered('AB/y.md', s)).toBe(false);
		expect(isCovered('B/x.md', s)).toBe(true);
		expect(countCovered(['A/1.md', 'A/b/2.md', 'AB/3.md', 'B/x.md', 'C.md'], s)).toBe(3);
	});
	it('makes one instruction line for other agents', () => {
		expect(instructionSnippet(set(['A', 'B'], ['N.md']))).toBe('Do not read, search, quote or edit these private paths in this vault. A/, B/, N.md');
		expect(instructionSnippet(set([]))).toBe('');
	});
});

describe('ignore file block', () => {
	it('appends a block and keeps user lines', () => {
		const r = mergeIgnoreBlock('node_modules/\n*.log\n', set(['Journal']), '.cursorignore');
		expect(r).toEqual({ ok: true, changed: true, text: `node_modules/\n*.log\n\n${BLOCK_BEGIN}\n/Journal/\n${BLOCK_END}\n` });
	});
	it('replaces the block in place and is idempotent', () => {
		const first = mergeIgnoreBlock(`a\n${BLOCK_BEGIN}\n/Old/\n${BLOCK_END}\nb\n`, set(['New']), '.geminiignore');
		expect(first).toEqual({ ok: true, changed: true, text: `a\n${BLOCK_BEGIN}\n/New/\n${BLOCK_END}\nb\n` });
		if (!first.ok) return;
		expect(mergeIgnoreBlock(first.text, set(['New']), '.geminiignore')).toEqual({ ok: true, changed: false, text: first.text });
	});
	it('removes the block when the list is empty', () => {
		expect(mergeIgnoreBlock(`a\n\n${BLOCK_BEGIN}\n/Old/\n${BLOCK_END}\n`, set([]), 'x')).toEqual({ ok: true, changed: true, text: 'a\n' });
		expect(mergeIgnoreBlock(null, set([]), 'x')).toEqual({ ok: true, changed: false, text: '' });
	});
	it('creates a new file', () => {
		expect(mergeIgnoreBlock(null, set(['A']), 'x')).toEqual({ ok: true, changed: true, text: `${BLOCK_BEGIN}\n/A/\n${BLOCK_END}\n` });
	});
	it('keeps CRLF line ends', () => {
		const r = mergeIgnoreBlock('a\r\n', set(['A']), 'x');
		expect(r.ok && r.text).toBe(`a\r\n\r\n${BLOCK_BEGIN}\r\n/A/\r\n${BLOCK_END}\r\n`);
	});
	it('refuses a broken block', () => {
		for (const bad of [`${BLOCK_BEGIN}\n/A/\n`, `${BLOCK_END}\n${BLOCK_BEGIN}\n`, `${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`]) {
			const r = mergeIgnoreBlock(bad, set(['A']), '.cursorignore');
			expect(r.ok).toBe(false);
		}
	});
});

describe('self-test', () => {
	it('passes when the files hold every rule', () => {
		const s = set(['A']);
		const claude = mergeClaudeSettings(null, s);
		const cursor = mergeIgnoreBlock(null, s, '.cursorignore');
		if (!claude.ok || !cursor.ok) throw new Error('refused');
		const rows = selfTest(s, claude.text, cursor.text, undefined);
		expect(rows.map(r => [r.target, r.ok])).toEqual([['.claude/settings.json', true], ['.cursorignore', true]]);
	});
	it('reports a missing rule, a missing file and bad JSON', () => {
		const s = set(['A', 'B']);
		const partial = JSON.stringify({ permissions: { deny: ['Read(/A/**)', 'Edit(/A/**)'] } });
		const rows = selfTest(s, partial, null, `${BLOCK_BEGIN}\n/A/\n${BLOCK_END}\n`);
		expect(rows[0]).toMatchObject({ ok: false, missing: ['Read(/B/**)', 'Edit(/B/**)'] });
		expect(rows[1]).toMatchObject({ target: '.cursorignore', ok: false, note: 'The file is missing.' });
		expect(rows[2]).toMatchObject({ target: '.geminiignore', ok: false, missing: ['/B/'] });
		expect(selfTest(s, '{', undefined, undefined)[0]).toMatchObject({ ok: false, note: 'The file is not valid JSON.' });
		expect(selfTest(s, null, undefined, undefined)[0]).toMatchObject({ ok: false, note: 'The file is missing.' });
	});
});

describe('review fixes', () => {
	it('keeps a byte order mark and parses the file behind it', () => {
		const r = mergeClaudeSettings('﻿{"model":"opus"}\n', set(['A']));
		if (!r.ok) throw new Error('refused');
		expect(r.text.startsWith('﻿{')).toBe(true);
		expect(r.text.indexOf('﻿', 1)).toBe(-1);
		expect(JSON.parse(r.text.slice(1)).model).toBe('opus');
		const again = mergeClaudeSettings(r.text, set(['A']), r.rules);
		expect(again.ok && again.changed).toBe(false);
		expect(selfTest(set(['A']), r.text, undefined, undefined)[0]!.ok).toBe(true);
	});

	it('keeps number text exactly, also above 2^53', () => {
		const src = '{\n  "big": 12345678901234567890,\n  "f": 1.0,\n  "e": -2.5E+3,\n  "list": [1, 0.10],\n  "__proto__": {"x": 1}\n}\n';
		const r = mergeClaudeSettings(src, set(['A']));
		if (!r.ok) throw new Error('refused');
		expect(r.text).toContain('"big": 12345678901234567890');
		expect(r.text).toContain('"f": 1.0');
		expect(r.text).toContain('"e": -2.5E+3');
		expect(r.text).toContain('0.10');
		expect(r.text).toContain('"__proto__": {');
		expect(JSON.parse(r.text).permissions.deny).toEqual(['Read(/A/**)', 'Edit(/A/**)']);
	});

	it('does not claim a rule that was in the file before', () => {
		const r = mergeClaudeSettings('{"permissions":{"deny":["Read(/A/**)"]}}', set(['A']));
		if (!r.ok) throw new Error('refused');
		expect(r.rules).toEqual(['Edit(/A/**)']);
		const off = mergeClaudeSettings(r.text, set([]), r.rules);
		if (!off.ok) throw new Error('refused');
		expect(JSON.parse(off.text).permissions.deny).toEqual(['Read(/A/**)']);
	});

	it('handles 10,000 tagged notes in under 200 ms for the merge and the self-test', () => {
		const files = Array.from({ length: 10000 }, (_, i) => `Notes/n${i}.md`);
		const s = set(Array.from({ length: 50 }, (_, i) => `F${i}`), files);
		const first = mergeClaudeSettings(null, s);
		if (!first.ok) throw new Error('refused');
		const cursor = mergeIgnoreBlock(null, s, '.cursorignore');
		if (!cursor.ok) throw new Error('refused');
		let t = performance.now();
		const again = mergeClaudeSettings(first.text, s, first.rules);
		expect(performance.now() - t).toBeLessThan(200);
		expect(again.ok && again.changed).toBe(false);
		t = performance.now();
		const rows = selfTest(s, first.text, cursor.text, cursor.text);
		expect(performance.now() - t).toBeLessThan(200);
		expect(rows.every(r => r.ok)).toBe(true);
	});
});
