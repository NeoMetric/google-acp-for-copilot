/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCustomizations } from '../../src/customizations';
import type { Skill } from '../../src/skills';
import { buildSystemPromptAppend, INSTRUCTIONS_CHAR_BUDGET, loadInstructions, SKILLS_CHAR_BUDGET } from '../../src/systemPrompt';

const skill = (name: string, description = `Does ${name}`): Skill => ({ name, description, file: `/skills/${name}/SKILL.md` });
const allTools = ['read_file', 'memory', 'run_in_terminal'];

describe('buildSystemPromptAppend', () => {
	it('is undefined when there is nothing to add', () => {
		expect(buildSystemPromptAppend({ skills: [], instructions: [], toolNames: [] })).toBeUndefined();
		expect(buildSystemPromptAppend({ skills: [], instructions: [], toolNames: ['run_in_terminal'] })).toBeUndefined();
	});

	it('lists each skill with its description and file', () => {
		const text = buildSystemPromptAppend({ skills: [skill('review'), skill('tidy')], instructions: [], toolNames: allTools })!;

		expect(text).toContain('## Skills');
		expect(text).toContain('- review: Does review (/skills/review/SKILL.md)');
		expect(text).toContain('- tidy: Does tidy (/skills/tidy/SKILL.md)');
	});

	it('lists the skills whatever tools the chat offers', () => {
		expect(buildSystemPromptAppend({ skills: [skill('review')], instructions: [], toolNames: [] })).toContain('## Skills');
		expect(buildSystemPromptAppend({ skills: [skill('review')], instructions: [], toolNames: ['view', 'powershell'] })).toContain('- review:');
	});

	it('mentions memory only when the chat has the memory tool, and loads none of it', () => {
		const withMemory = buildSystemPromptAppend({ skills: [], instructions: [], toolNames: allTools })!;
		const withoutMemory = buildSystemPromptAppend({ skills: [skill('a')], instructions: [], toolNames: ['read_file'] })!;

		expect(withMemory).toContain('`memory` tool of the `vscode` MCP server');
		expect(withMemory).toContain('Nothing from it is loaded for you');
		expect(withoutMemory).not.toContain('## Memory');
	});

	it('stops listing skills at the budget and says how many were left out', () => {
		const many = Array.from({ length: 500 }, (_, index) => skill(`skill-${String(index).padStart(3, '0')}`, 'x'.repeat(300)));

		const text = buildSystemPromptAppend({ skills: many, instructions: [], toolNames: allTools })!;
		const section = text.slice(text.indexOf('## Skills'), text.indexOf('## Memory'));

		expect(section.length).toBeLessThanOrEqual(SKILLS_CHAR_BUDGET + 1000);
		expect(section).toContain('- skill-000:');
		expect(section).not.toContain('- skill-499:');
		expect(section).toMatch(/- … \d+ more skills not listed/);
	});

	it('is identical for identical input, so prompt caching holds', () => {
		const input = { skills: [skill('a'), skill('b')], instructions: [{ source: 'repo/AGENTS.md', text: 'Be kind.' }], toolNames: allTools };

		expect(buildSystemPromptAppend(input)).toBe(buildSystemPromptAppend({ ...input }));
	});

	it('includes instruction files, cutting them at the budget', () => {
		const text = buildSystemPromptAppend({
			skills: [],
			instructions: [
				{ source: 'repo/AGENTS.md', text: '  Use tabs.  ' },
				{ source: 'repo/.github/copilot-instructions.md', text: 'y'.repeat(INSTRUCTIONS_CHAR_BUDGET * 2) },
				{ source: 'repo/dropped.md', text: 'never shown' },
				{ source: 'repo/blank.md', text: '   ' },
			],
			toolNames: [],
		})!;

		expect(text).toContain('## Instructions from repo/AGENTS.md\n\nUse tabs.');
		expect(text).toContain('## Instructions from repo/.github/copilot-instructions.md');
		expect(text).toContain('… (cut)');
		expect(text).not.toContain('dropped.md');
		expect(text).not.toContain('blank.md');
	});

	it('does not claim to be GitHub Copilot or name Copilot-only tools', () => {
		const text = buildSystemPromptAppend({ skills: [skill('a')], instructions: [], toolNames: allTools })!;

		expect(text).not.toMatch(/you are github copilot/i);
		expect(text).not.toContain('run_in_terminal');
		expect(text).not.toContain('manage_todo_list');
	});
});

describe('loadInstructions', () => {
	let temp: string;

	beforeEach(() => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-acp-instructions-'));
	});

	afterEach(() => {
		fs.rmSync(temp, { recursive: true, force: true });
	});

	it('reads AGENTS.md and the Copilot instructions file of each folder', async () => {
		const folder = path.join(temp, 'repo');
		fs.mkdirSync(path.join(folder, '.github'), { recursive: true });
		fs.writeFileSync(path.join(folder, 'AGENTS.md'), 'agents text');
		fs.writeFileSync(path.join(folder, '.github', 'copilot-instructions.md'), 'copilot text');

		expect(await loadInstructions([folder])).toEqual([
			{ source: 'repo/.github/copilot-instructions.md', text: 'copilot text' },
			{ source: 'repo/AGENTS.md', text: 'agents text' },
		]);
	});

	it('skips missing and blank files', async () => {
		const folder = path.join(temp, 'repo');
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, 'AGENTS.md'), '  \n');

		expect(await loadInstructions([folder, path.join(temp, 'absent')])).toEqual([]);
	});
});

describe('customization files', () => {
	const file = (kind: 'instructions' | 'agent' | 'prompt', name: string, extra: { applyTo?: string; description?: string } = {}) =>
		({ kind, name, description: extra.description ?? '', file: `/c/${name}`, applyTo: extra.applyTo });

	it('lists instruction, agent and prompt files in their own sections', () => {
		const text = buildSystemPromptAppend({
			skills: [],
			instructions: [],
			toolNames: [],
			customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts', description: 'TypeScript rules' }), file('agent', 'reviewer'), file('prompt', 'ship')],
		})!;

		expect(text).toContain('## Instruction files for specific files');
		expect(text).toContain('- ts [applies to: **/*.ts]: TypeScript rules (/c/ts)');
		expect(text).toContain('## Custom agents');
		expect(text).toContain('- reviewer (/c/reviewer)');
		expect(text).toContain('## Prompt files');
		expect(text).toContain('- ship (/c/ship)');
	});

	it('reads them from the user and workspace folders, with always-on instructions inline', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
		try {
			fs.mkdirSync(path.join(repo, '.github', 'instructions'), { recursive: true });
			fs.mkdirSync(path.join(repo, '.github', 'agents'), { recursive: true });
			fs.mkdirSync(path.join(home, '.copilot', 'prompts'), { recursive: true });
			fs.writeFileSync(path.join(repo, '.github', 'instructions', 'all.instructions.md'), '---\napplyTo: "**"\n---\nAlways be brief.');
			fs.writeFileSync(path.join(repo, '.github', 'instructions', 'ts.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nUse strict mode.');
			fs.writeFileSync(path.join(repo, '.github', 'agents', 'reviewer.agent.md'), '---\ndescription: Reviews code\n---\nBody');
			fs.writeFileSync(path.join(home, '.copilot', 'prompts', 'ship.prompt.md'), '---\ndescription: Ship it\n---\nBody');

			const found = await discoverCustomizations(home, [repo]);

			expect(found.alwaysOn.map(item => item.text.trim())).toEqual(['Always be brief.']);
			expect(found.files.map(item => `${item.kind}:${item.name}:${item.applyTo ?? ''}`).sort()).toEqual(['agent:reviewer:', 'instructions:ts:**/*.ts', 'prompt:ship:']);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it('also reads the profile prompts folder and folders added through settings', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
		const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'));
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
		try {
			fs.mkdirSync(path.join(repo, 'team', 'prompts'), { recursive: true });
			fs.mkdirSync(path.join(home, 'mine'), { recursive: true });
			fs.writeFileSync(path.join(profile, 'p.instructions.md'), '---\napplyTo: "**/*.py"\n---\nPython.');
			fs.writeFileSync(path.join(shared, 'a.agent.md'), '---\ndescription: Shared\n---\nBody');
			fs.writeFileSync(path.join(shared, 'off.agent.md'), 'Body');
			fs.writeFileSync(path.join(repo, 'team', 'prompts', 'r.prompt.md'), 'Body');
			fs.writeFileSync(path.join(home, 'mine', 'h.prompt.md'), 'Body');

			const found = await discoverCustomizations(home, [repo], {
				profilePromptsDir: profile,
				locations: {
					agent: { [shared]: true, [path.join(shared, 'missing')]: false },
					prompt: { 'team/prompts': true, '~/mine': true, '~/mine/': true },
				},
			});

			expect(found.files.map(item => `${item.kind}:${item.name}`).sort()).toEqual(['agent:a', 'agent:off', 'instructions:p', 'prompt:h', 'prompt:r']);
		} finally {
			for (const dir of [home, repo, shared, profile]) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});

