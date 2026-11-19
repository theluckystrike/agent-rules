import { describe, expect, it } from 'vitest';
import { buildRuleTree, collectRuleFiles, countTreeFiles, indexByFolder, rulesForFolder } from '../src/rules';
import { backupPath, mirrorContent, mirrorState } from '../src/mirror';

const paths = ['AGENTS.md', 'CLAUDE.md', 'notes/a.md', 'Projects/AGENTS.md', 'Projects/App/GEMINI.md', 'Projects/App/src/AGENTS.md', 'Other/agents.md', 'Other/MY-AGENTS.md', 'Journal/2026/x.md'];

describe('rule file index', () => {
	it('picks only the exact rule file names', () => {
		expect(collectRuleFiles(paths).map(f => f.path)).toEqual(['AGENTS.md', 'CLAUDE.md', 'Projects/AGENTS.md', 'Projects/App/GEMINI.md', 'Projects/App/src/AGENTS.md']);
	});

	it('builds a folder tree with only the folders on the way to a rule file', () => {
		const tree = buildRuleTree(collectRuleFiles(paths));
		expect(tree.files.map(f => f.name)).toEqual(['AGENTS.md', 'CLAUDE.md']);
		expect(tree.children.map(c => c.path)).toEqual(['Projects']);
		expect(tree.children[0]!.children[0]!.path).toBe('Projects/App');
		expect(tree.children[0]!.children[0]!.children[0]!.path).toBe('Projects/App/src');
		expect(countTreeFiles(tree)).toBe(5);
	});

	it('sorts files as AGENTS.md, CLAUDE.md, GEMINI.md and folders by name', () => {
		const tree = buildRuleTree(collectRuleFiles(['b/GEMINI.md', 'b/AGENTS.md', 'a/CLAUDE.md', 'GEMINI.md', 'AGENTS.md']));
		expect(tree.files.map(f => f.name)).toEqual(['AGENTS.md', 'GEMINI.md']);
		expect(tree.children.map(c => c.label)).toEqual(['a', 'b']);
		expect(tree.children[1]!.files.map(f => f.name)).toEqual(['AGENTS.md', 'GEMINI.md']);
	});

	it('lists the nearest rules from the vault root down', () => {
		const by = indexByFolder(collectRuleFiles(paths));
		expect(rulesForFolder('Projects/App/src/lib', by)).toEqual([
			{ name: 'AGENTS.md', chain: ['AGENTS.md', 'Projects/AGENTS.md', 'Projects/App/src/AGENTS.md'] },
			{ name: 'CLAUDE.md', chain: ['CLAUDE.md'] },
			{ name: 'GEMINI.md', chain: ['Projects/App/GEMINI.md'] },
		]);
		expect(rulesForFolder('', by).map(a => a.chain)).toEqual([['AGENTS.md'], ['CLAUDE.md']]);
		expect(rulesForFolder('Projectsx', by).map(a => a.chain)).toEqual([['AGENTS.md'], ['CLAUDE.md']]);
		expect(rulesForFolder('x', new Map())).toEqual([]);
	});

	it('builds the tree for 10,000 notes with 200 rule files in under 500 ms', () => {
		const all: string[] = [];
		for (let i = 0; i < 10000; i++) all.push(`Area ${i % 50}/Topic ${i % 400}/Note ${i}.md`);
		for (let i = 0; i < 200; i++) all.push(`Area ${i % 50}/Topic ${i}/${['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'][i % 3]}`);
		const t0 = performance.now();
		const files = collectRuleFiles(all);
		const tree = buildRuleTree(files);
		const by = indexByFolder(files);
		for (let i = 0; i < 200; i++) rulesForFolder(`Area ${i % 50}/Topic ${i}/deep`, by);
		const ms = performance.now() - t0;
		expect(files).toHaveLength(200);
		expect(countTreeFiles(tree)).toBe(200);
		expect(ms).toBeLessThan(500);
	});

	it('scales linearly, so 10 times the notes costs far less than 100 times the time', () => {
		const make = (n: number): string[] => Array.from({ length: n }, (_, i) => `F${i % 300}/S${i % 1000}/${i % 50 === 0 ? 'AGENTS.md' : `n${i}.md`}`);
		const time = (p: string[]): number => { const t = performance.now(); buildRuleTree(collectRuleFiles(p)); return performance.now() - t; };
		const small = make(10000);
		const big = make(100000);
		time(small);
		const a = Math.max(time(small), 0.5);
		const b = time(big);
		expect(b / a).toBeLessThan(40);
	});
});

describe('import files', () => {
	it('uses the documented import lines', () => {
		expect(mirrorContent('CLAUDE.md').split('\n')[1]).toBe('@AGENTS.md');
		expect(mirrorContent('GEMINI.md').split('\n')[1]).toBe('@./AGENTS.md');
	});
	it('tells missing, in step and hand-edited files apart', () => {
		expect(mirrorState('CLAUDE.md', null)).toBe('missing');
		expect(mirrorState('CLAUDE.md', mirrorContent('CLAUDE.md'))).toBe('in-step');
		expect(mirrorState('CLAUDE.md', mirrorContent('CLAUDE.md').replace(/\n/g, '\r\n'))).toBe('in-step');
		expect(mirrorState('CLAUDE.md', '@AGENTS.md\n')).toBe('hand-edited');
		expect(mirrorState('CLAUDE.md', `${mirrorContent('CLAUDE.md')}\n- my own rule\n`)).toBe('hand-edited');
		expect(mirrorState('GEMINI.md', mirrorContent('CLAUDE.md'))).toBe('hand-edited');
	});
	it('makes a backup path in the hidden folder', () => {
		expect(backupPath('a/CLAUDE.md', new Date(2026, 10, 19, 9, 5, 7))).toBe('.agent-rules-backup/a/CLAUDE.md.20261119-090507.bak');
	});
});
