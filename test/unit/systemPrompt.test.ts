/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { customInstructionsBlock, toAcpContentBlocks } from '../../src/convert';
import { discoverCustomizations } from '../../src/customizations';
import { guidanceDiffers } from '../../src/provider';
import { systemGuidanceOf } from '../../src/requestContext';
import { assistant, system, user } from './messages';
import { buildSystemPromptAppend, CUSTOM_FILES_CHAR_BUDGET } from '../../src/systemPrompt';

const file = (kind: 'instructions' | 'prompt', name: string, extra: { applyTo?: string; description?: string } = {}) =>
	({ kind, name, description: extra.description ?? '', file: `/c/${name}`, applyTo: extra.applyTo });

describe('prompt stability and duplication', () => {
	const hostSystem = (mode: string) => system(`You are an expert AI programming assistant, working with a user in the VS Code editor.\nKeep your answers short and impersonal.\n<environment_context>\n* Current working directory: c:\\repo\n</environment_context>\n<rules>${mode}</rules>`);
	const instructions = 'When generating code, please follow these user provided coding instructions.\n<instructions>\nUse tabs.\n</instructions>';

	/** What the agent gets as the append for the chat that a request opens, and the per-turn text it is sent. */
	const turn = (messages: ReturnType<typeof user>[]) => ({
		append: buildSystemPromptAppend({ guidance: systemGuidanceOf(messages), customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts' })] }),
		guidance: systemGuidanceOf(messages),
		blocks: toAcpContentBlocks(messages),
		instructions: customInstructionsBlock(messages)?.text,
	});

	it('keeps the appended prompt and the guidance byte-identical across consecutive turns', () => {
		const first = [hostSystem('Be careful.'), user(`${instructions}\n<context>10:00</context><userRequest>one</userRequest>`)];
		const second = [hostSystem('Be careful.'), user(`${instructions}\n<context>10:05</context><userRequest>one</userRequest>`), assistant('done'), user(`${instructions}\n<context>10:06</context><userRequest>two</userRequest>`)];
		const [a, b] = [turn(first), turn(second)];

		expect(b.append).toBe(a.append);
		expect(Buffer.from(b.append!).equals(Buffer.from(a.append!))).toBe(true);
		expect(guidanceDiffers(a.guidance, b.guidance)).toBe(false);
		expect(b.instructions).toBe(a.instructions);
	});

	it('keeps per-turn state out of the appended prompt', () => {
		const { append } = turn([hostSystem('Be careful.'), user('<context>It is 10:00.</context><editorContext>open.ts</editorContext><userRequest>go</userRequest>')]);

		expect(append).not.toContain('10:00');
		expect(append).not.toContain('open.ts');
		expect(append).not.toContain('userRequest');
	});

	it('sends the identity-free introduction, the guidance and every instruction exactly once', () => {
		const messages = [hostSystem('Be careful.'), user(`${instructions}\n<userRequest>go</userRequest>`)];
		const { append, blocks, instructions: custom } = turn(messages);
		const everything = [append, ...blocks.map(block => (block.type === 'text' ? block.text : '')), custom].join('\n');

		expect(everything.match(/Follow Microsoft content policies\./g)).toHaveLength(1);
		expect(everything.match(/Current working directory: c:/g)).toHaveLength(1);
		expect(everything.match(/Use tabs\./g)).toHaveLength(1);
		expect(everything).not.toContain('impersonal');
	});

	it('lists the instruction files in a fixed order', () => {
		const files = [file('instructions', 'a', { applyTo: '*.a' }), file('instructions', 'b', { applyTo: '*.b' }), file('prompt', 'p')];

		expect(buildSystemPromptAppend({ customFiles: files, guidance: 'g' })).toBe(buildSystemPromptAppend({ customFiles: [...files], guidance: 'g' }));
	});
});

describe('buildSystemPromptAppend', () => {
	it('is undefined when there is nothing to add', () => {
		expect(buildSystemPromptAppend({})).toBeUndefined();
		expect(buildSystemPromptAppend({ customFiles: [] })).toBeUndefined();
	});

	it('keeps the positive rule to only call call_mcp_tool', () => {
		const text = buildSystemPromptAppend({ guidance: '<environment_context>Go.</environment_context>' })!;

		expect(text).toContain('reach them only through `call_mcp_tool`');
	});

	it("tells the agent that a note on a tool result is the user's own message", () => {
		const text = buildSystemPromptAppend({ guidance: '<environment_context>Go.</environment_context>' })!;

		expect(text).toContain('the user sent a new message while the tool ran');
		expect(text).toContain('treat them as their newest message');
	});

	it('lists the arguments each tool requires, read from its schema', () => {
		const text = buildSystemPromptAppend({
			toolArguments: [
				{ name: 'powershell', required: ['command', 'description'] },
				{ name: 'view', required: [] },
			],
		})!;

		expect(text).toContain('## Tool arguments');
		expect(text).toContain('- powershell: command, description');
		expect(text).not.toContain('- view:');
	});

	it('adds no tool arguments section when no tool requires an argument', () => {
		expect(buildSystemPromptAppend({ toolArguments: [{ name: 'view', required: [] }] })).toBeUndefined();
	});

	it('forwards the guidance the host rendered for the chat, before the pointers', () => {
		const text = buildSystemPromptAppend({
			customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts' })],
			guidance: '<environment_context>\n* Current working directory: c:\\repo\n</environment_context>',
		})!;

		expect(text).toContain('* Current working directory: c:\\repo');
		expect(text.indexOf('Current working directory')).toBeLessThan(text.indexOf('## Instruction files for specific files'));
	});

	it('forwards guidance even when the folders carry nothing', () => {
		expect(buildSystemPromptAppend({ guidance: '<environment_context>Go.</environment_context>' }))
			.toContain('<environment_context>Go.</environment_context>');
	});

	it('leaves skills, agents and memory to the host, adding none of its own', () => {
		const text = buildSystemPromptAppend({
			guidance: [
				'<available_skills><skill><name>review</name><location>user</location></skill></available_skills>',
				'<agents><agent><name>reviewer</name></agent></agents>',
				'<memoryInstructions>Keep notes short.</memoryInstructions>',
			].join('\n'),
		})!;

		expect(text).toContain('<available_skills>');
		expect(text).toContain('<agents>');
		expect(text).toContain('<memoryInstructions>');
		expect(text).not.toContain('## Skills');
		expect(text).not.toContain('## Custom agents');
		expect(text).not.toContain('## Memory');
	});

	it('keeps the rules for the content the model may produce', () => {
		const text = buildSystemPromptAppend({ guidance: '<environment_context>Go.</environment_context>' })!;

		expect(text).toContain('Follow Microsoft content policies.');
		expect(text).toContain('Avoid content that violates copyrights.');
		expect(text).toContain('only respond with "Sorry, I can\'t assist with that."');
	});

	it('does not claim to be GitHub Copilot or name Copilot-only tools', () => {
		const text = buildSystemPromptAppend({ guidance: '<environment_context>Go.</environment_context>' })!;

		expect(text).not.toMatch(/you are github copilot/i);
		expect(text).not.toContain('run_in_terminal');
		expect(text).not.toContain('manage_todo_list');
	});

	it('does not repeat a file the guidance already names, so nothing is paid for twice', () => {
		const text = buildSystemPromptAppend({
			customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts' })],
			guidance: '<instructions><instruction><file>/c/ts</file></instruction></instructions>',
		})!;

		expect(text).not.toContain('## Instruction files for specific files');
	});

	it('lists a file the guidance does not name', () => {
		const text = buildSystemPromptAppend({
			customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts' })],
			guidance: '<code_change_instructions>Make precise, surgical changes.</code_change_instructions>',
		})!;

		expect(text).toContain('## Instruction files for specific files');
		expect(text).toContain('- ts [applies to: **/*.ts] (/c/ts)');
	});

	it('stops listing customization files at the budget', () => {
		const many = Array.from({ length: 500 }, (_, index) => file('prompt', `p-${String(index).padStart(3, '0')}`, { description: 'x'.repeat(200) }));

		const text = buildSystemPromptAppend({ customFiles: many })!;
		const section = text.slice(text.indexOf('## Prompt files'));

		expect(section.length).toBeLessThanOrEqual(CUSTOM_FILES_CHAR_BUDGET + 1000);
		expect(section).toContain('- p-000:');
		expect(section).not.toContain('- p-499:');
		expect(section).toMatch(/- … \d+ more not listed/);
	});

	it('is identical for identical input, so prompt caching holds', () => {
		const input = { customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts' })], guidance: '<context>Go.</context>' };

		expect(buildSystemPromptAppend(input)).toBe(buildSystemPromptAppend({ ...input }));
	});
});

describe('customization files', () => {
	it('lists instruction and prompt files in their own sections', () => {
		const text = buildSystemPromptAppend({
			customFiles: [file('instructions', 'ts', { applyTo: '**/*.ts', description: 'TypeScript rules' }), file('prompt', 'ship')],
		})!;

		expect(text).toContain('## Instruction files for specific files');
		expect(text).toContain('- ts [applies to: **/*.ts]: TypeScript rules (/c/ts)');
		expect(text).toContain('## Prompt files');
		expect(text).toContain('- ship (/c/ship)');
	});

	it('reads them from the user and workspace folders as pointers', async () => {
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

			expect(found.files.map(item => `${item.kind}:${item.name}:${item.applyTo ?? ''}`).sort()).toEqual(['instructions:all:**', 'instructions:ts:**/*.ts', 'prompt:ship:']);
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
			fs.writeFileSync(path.join(shared, 's.instructions.md'), '---\napplyTo: "**/*.go"\n---\nGo.');
			fs.writeFileSync(path.join(shared, 'off.instructions.md'), 'Body');
			fs.writeFileSync(path.join(repo, 'team', 'prompts', 'r.prompt.md'), 'Body');
			fs.writeFileSync(path.join(home, 'mine', 'h.prompt.md'), 'Body');

			const found = await discoverCustomizations(home, [repo], {
				profilePromptsDir: profile,
				locations: {
					instructions: { [shared]: true, [path.join(shared, 'missing')]: false },
					prompt: { 'team/prompts': true, '~/mine': true, '~/mine/': true },
				},
			});

			expect(found.files.map(item => `${item.kind}:${item.name}`).sort()).toEqual(['instructions:off', 'instructions:p', 'instructions:s', 'prompt:h', 'prompt:r']);
		} finally {
			for (const dir of [home, repo, shared, profile]) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});
