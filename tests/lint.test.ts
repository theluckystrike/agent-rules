import { describe, expect, it } from 'vitest';
import { countLines, deadLinks, duplicateRules, duplicatesLoadedTogether, estimateTokens, findLinks, lintFile, loadTogether, resolveRelative, ruleKey, stripCode } from '../src/lint';

describe('length', () => {
	it('estimates tokens at 4 characters each', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('abcde')).toBe(2);
	});
	it('counts lines with and without a final line end', () => {
		expect(countLines('')).toBe(0);
		expect(countLines('a')).toBe(1);
		expect(countLines('a\nb\n')).toBe(2);
	});
	it('flags a file over 200 lines', () => {
		const r = lintFile('AGENTS.md', '', 'x\n'.repeat(201), () => true, () => true);
		expect(r).toMatchObject({ lines: 201, long: true });
		expect(lintFile('AGENTS.md', '', 'x\n'.repeat(200), () => true, () => true).long).toBe(false);
	});
});

describe('links', () => {
	const text = [
		'@docs/style.md and @missing/file.md',
		'See [guide](../guide.md) and [site](https://example.com) and [top](#top).',
		'![image](pic.png) is an image.',
		'[[Note A]] and [[Gone|alias]]',
		'`@not/an/import.md` stays literal',
		'```',
		'@also/not.md [[NotALink]]',
		'```',
		'mail me @bob or user@example.com',
		'@Design\\ Docs/a.md',
	].join('\n');
	it('finds imports, links and wikilinks outside code', () => {
		expect(findLinks(text).map(r => `${r.kind} ${r.target} ${r.line}`)).toEqual([
			'import docs/style.md 1', 'import missing/file.md 1', 'markdown ../guide.md 2', 'wiki Note A 4', 'wiki Gone 4', 'import Design Docs/a.md 10',
		]);
	});
	it('reports only the dead links', () => {
		const files = new Set(['proj/docs/style.md', 'guide.md', 'proj/Design Docs/a.md']);
		const dead = deadLinks(text, 'proj', p => files.has(p), l => l === 'Note A');
		expect(dead.map(d => `${d.target} -> ${d.resolved}`)).toEqual(['missing/file.md -> proj/missing/file.md', 'Gone -> null']);
	});
	it('resolves relative paths and skips paths outside the vault', () => {
		expect(resolveRelative('a/b', '../c.md')).toBe('a/c.md');
		expect(resolveRelative('', '../c.md')).toBeNull();
		expect(resolveRelative('a', '~/x.md')).toBeNull();
		expect(resolveRelative('a', '/x.md')).toBe('x.md');
	});
	it('keeps line numbers when it removes code', () => {
		expect(stripCode('a\n```\nb\n```\nc')).toEqual(['a', '', '', '', 'c']);
		expect(stripCode('~~~\n```\nx\n~~~\ny')).toEqual(['', '', '', '', 'y']);
	});
});

describe('duplicate rules', () => {
	it('normalizes list marks, case and end marks', () => {
		expect(ruleKey('- Keep each note in **Markdown**.')).toBe('keep each note in markdown');
		expect(ruleKey('1. keep each note in markdown')).toBe('keep each note in markdown');
		expect(ruleKey('## Heading text here')).toBeNull();
		expect(ruleKey('- short')).toBeNull();
	});
	it('finds a rule twice in one file and across files', () => {
		const d = duplicateRules([
			{ path: 'AGENTS.md', text: '- Ask before you delete a note.\n- Ask before you delete a note\n' },
			{ path: 'a/AGENTS.md', text: '* ask before you DELETE a note.' },
		]);
		expect(d).toHaveLength(1);
		expect(d[0]!.places).toEqual([{ path: 'AGENTS.md', line: 1 }, { path: 'AGENTS.md', line: 2 }, { path: 'a/AGENTS.md', line: 1 }]);
	});
	it('keeps only the duplicates that load together', () => {
		expect(loadTogether('a/AGENTS.md', 'a/b/CLAUDE.md')).toBe(true);
		expect(loadTogether('AGENTS.md', 'x/CLAUDE.md')).toBe(true);
		expect(loadTogether('a/AGENTS.md', 'ab/AGENTS.md')).toBe(false);
		expect(loadTogether('a/AGENTS.md', 'b/AGENTS.md')).toBe(false);
		const d = duplicatesLoadedTogether([
			{ path: 'a/AGENTS.md', text: '- Use wikilinks for every link.' },
			{ path: 'b/AGENTS.md', text: '- Use wikilinks for every link.' },
		]);
		expect(d).toEqual([]);
	});
	it('ignores rules inside code blocks', () => {
		expect(duplicateRules([{ path: 'A', text: '```\n- run the tests first\n- run the tests first\n```' }])).toEqual([]);
	});
	it('checks 200 files of 200 lines fast', () => {
		const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}/AGENTS.md`, text: Array.from({ length: 200 }, (_, j) => `- rule number ${j} for file ${i % 2}`).join('\n') }));
		const t = performance.now();
		const d = duplicateRules(files);
		expect(performance.now() - t).toBeLessThan(1000);
		expect(d).toHaveLength(400);
	});
});
