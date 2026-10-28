/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { conversationIdOf, resolveCwd, systemGuidanceOf, workspaceFoldersOf } from '../../src/requestContext';
import { sessionKey } from '../../src/provider';
import { assistant, system, user } from './messages';

const options = (modelOptions?: Record<string, unknown>) => ({ modelOptions, tools: [], toolMode: 1 }) as unknown as vscode.ProvideLanguageModelChatResponseOptions;

/** The first user message Copilot sends: environment and workspace, with no request. */
const globalContext = (folders: string, extra = '') => user(
	`<environment_info>\nThe user's current OS is: Windows\n</environment_info>\n<workspace_info>\n${folders}${extra}\n</workspace_info>`,
);

const oneFolder = (folder: string) => `I am working in a workspace with the following folders:\n- ${folder} `;

/** The system prompt the Copilot SDK host sends, which names the chat's own directory. */
const hostSystem = (cwd: string, root = cwd) => system(
	`You are an AI assistant using Copilot SDK in VS Code.\n<environment_context>\nYou are working in the following environment. You do not need to make additional tool calls to verify this.\n* Current working directory: ${cwd}\n* Git repository root: ${root}\n* Operating System: windows\n</environment_context>\nMore guidance.`,
);

/** The first user message the SDK host sends: a file listing whose first line is the root. */
const structureContext = (root: string) => user(
	`<workspace_info>\nInitial workspace structure (file names only):\n\`\`\`text\n${root}\nREADME.md\nsrc/\n\tindex.ts\n\`\`\`\n</workspace_info>\nfix the bug`,
);

describe('workspaceFoldersOf with the Copilot SDK host', () => {
	it('reads the working directory from the environment block of the system message', () => {
		const messages = [hostSystem('c:\\Users\\me\\repos\\app'), user('hi')];

		expect(workspaceFoldersOf(messages)).toEqual(['c:\\Users\\me\\repos\\app']);
	});

	it('uses the working directory, not the git root, when they differ', () => {
		expect(workspaceFoldersOf([hostSystem('/repo/packages/web', '/repo')])).toEqual(['/repo/packages/web']);
	});

	it('prefers the system message over a description in a user message', () => {
		const messages = [hostSystem('/from/system'), globalContext(oneFolder('/from/user'))];

		expect(workspaceFoldersOf(messages)).toEqual(['/from/system']);
	});

	it('ignores a working directory quoted by the user or the assistant', () => {
		const quote = '<environment_context>\n* Current working directory: /quoted\n</environment_context>';

		expect(workspaceFoldersOf([user(quote), assistant(quote)])).toBeUndefined();
	});

	it('reads the root of the structure listing when nothing else names a folder', () => {
		expect(workspaceFoldersOf([structureContext('c:\\\\Users\\\\me\\\\repos\\\\app')])).toEqual(['c:\\Users\\me\\repos\\app']);
		expect(workspaceFoldersOf([structureContext('/home/me/app')])).toEqual(['/home/me/app']);
	});

	it('ignores a structure listing that does not start with a path', () => {
		expect(workspaceFoldersOf([structureContext('README.md')])).toBeUndefined();
	});

	it('writes the drive letter in lower case, as hosts disagree about its case between requests', () => {
		expect(workspaceFoldersOf([hostSystem('C:\\work\\app')])).toEqual(['c:\\work\\app']);
		expect(workspaceFoldersOf([globalContext(oneFolder('C:\\work\\app'))])).toEqual(['c:\\work\\app']);
	});

	it('drops a trailing separator', () => {
		expect(workspaceFoldersOf([hostSystem('/repo/')])).toEqual(['/repo']);
	});
});

describe('workspaceFoldersOf', () => {
	it('reads the folder of the workspace Copilot describes', () => {
		const messages = [system('base'), globalContext(oneFolder('c:\\work\\app')), user('<userRequest>\nhi\n</userRequest>')];

		expect(workspaceFoldersOf(messages)).toEqual(['c:\\work\\app']);
	});

	it('reads every folder of a multi-root workspace in order', () => {
		const folders = 'I am working in a workspace with the following folders:\n- /a/one \n- /b/two ';

		expect(workspaceFoldersOf([globalContext(folders)])).toEqual(['/a/one', '/b/two']);
	});

	it('stops at the end of the folder list', () => {
		const extra = '\nI am working in a workspace that has the following structure:\n```\n- not-a-folder/\n```';

		expect(workspaceFoldersOf([globalContext(oneFolder('/repo'), extra)])).toEqual(['/repo']);
	});

	it('keeps folders with spaces in their names', () => {
		expect(workspaceFoldersOf([globalContext(oneFolder('/Users/me/My Projects/app'))])).toEqual(['/Users/me/My Projects/app']);
	});

	it('reports an empty list when Copilot says no workspace is open', () => {
		expect(workspaceFoldersOf([globalContext('There is no workspace currently open.')])).toEqual([]);
	});

	it('returns undefined when the request carries no workspace description', () => {
		expect(workspaceFoldersOf([user('hello'), assistant('hi')])).toBeUndefined();
	});

	it('ignores a description quoted in an assistant message', () => {
		expect(workspaceFoldersOf([assistant(`<workspace_info>\n${oneFolder('/quoted')}\n</workspace_info>`)])).toBeUndefined();
	});

	it('uses the first description, which Copilot freezes for the chat', () => {
		const messages = [globalContext(oneFolder('/first')), globalContext(oneFolder('/second'))];

		expect(workspaceFoldersOf(messages)).toEqual(['/first']);
	});
});

describe('conversationIdOf', () => {
	it('reads the id Copilot puts in the model options', () => {
		expect(conversationIdOf(options({ _conversationId: 'abc-123' }))).toBe('abc-123');
	});

	it('returns undefined when there is none', () => {
		expect(conversationIdOf(options())).toBeUndefined();
		expect(conversationIdOf(options({ _conversationId: '' }))).toBeUndefined();
		expect(conversationIdOf(options({ _conversationId: 7 }))).toBeUndefined();
	});
});

describe('resolveCwd', () => {
	const exists = (...present: string[]) => (candidate: string) => present.includes(candidate);

	it('prefers the chat\'s own folder over the window\'s', () => {
		expect(resolveCwd(['/chat'], '/window', exists('/chat', '/window'))).toBe('/chat');
	});

	it('skips folders that are not on this machine', () => {
		expect(resolveCwd(['/gone', '/there'], '/window', exists('/there'))).toBe('/there');
	});

	it('falls back to the window when the chat names no usable folder', () => {
		expect(resolveCwd(['/gone'], '/window', exists())).toBe('/window');
		expect(resolveCwd([], '/window', exists())).toBe('/window');
		expect(resolveCwd(undefined, '/window', exists())).toBe('/window');
	});
});

describe('sessionKey with request context', () => {
	const chat = [globalContext(oneFolder('/repo')), user('<userRequest>\nfix it\n</userRequest>')];

	it('keeps one key as the chat grows', () => {
		const later = [...chat, assistant('done'), user('<userRequest>\nthanks\n</userRequest>')];

		expect(sessionKey(later, options({ _conversationId: 'c1' }))).toBe(sessionKey(chat, options({ _conversationId: 'c1' })));
	});

	it('separates chats that open with the same words but have different conversation ids', () => {
		expect(sessionKey(chat, options({ _conversationId: 'c1' }))).not.toBe(sessionKey(chat, options({ _conversationId: 'c2' })));
	});

	it('separates the same opening words in different workspaces', () => {
		const other = [globalContext(oneFolder('/other')), user('<userRequest>\nfix it\n</userRequest>')];

		expect(sessionKey(chat, options())).not.toBe(sessionKey(other, options()));
	});

	it('still works without options', () => {
		expect(sessionKey(chat)).toBe(sessionKey(chat, options()));
	});

	describe('with the Copilot SDK host', () => {
		const id = options({ _conversationId: 'c1' });
		const turn = (prompt: ReturnType<typeof hostSystem>) => [prompt, user('first words'), assistant('ok'), user('second words')];

		it('keeps one key when the host re-renders the casing of a drive letter in its system message', () => {
			// Seen in a real request: `Git repository root` was `C:\` in one request and `c:\` in the next.
			const before = turn(hostSystem('c:\\repo', 'C:\\repo'));
			const after = turn(hostSystem('c:\\repo', 'c:\\repo'));

			expect(sessionKey(after, id)).toBe(sessionKey(before, id));
		});

		it('keys on the first messages of the chat, not on the system message ahead of them', () => {
			const messages = [user('first words'), assistant('ok')];

			expect(sessionKey([hostSystem('/repo'), ...messages], id)).toBe(sessionKey([hostSystem('/repo'), ...messages, user('later')], id));
		});

		it('still separates two chats that open differently in the same folder', () => {
			const one = [hostSystem('/repo'), user('first words')];
			const two = [hostSystem('/repo'), user('other words')];

			expect(sessionKey(one, id)).not.toBe(sessionKey(two, id));
		});

		it('roots the key in the folder the system message names, not the window\'s', () => {
			expect(sessionKey([hostSystem('/repo/one'), user('x')], id)).not.toBe(sessionKey([hostSystem('/repo/two'), user('x')], id));
			expect(sessionKey([hostSystem('/repo/one'), user('x')], id)).toContain('/repo/one');
		});
	});
});

describe('systemGuidanceOf', () => {
	/** The system prompt of the SDK host as it arrived in a real request, shortened. */
	const hostPrompt = (tail: string) => system([
		'You are an AI assistant using Copilot SDK in VS Code. You help users with software engineering tasks.',
		'<code_change_instructions>\nMake precise, surgical changes.\n</code_change_instructions>',
		'<environment_context>\nYou are working in the following environment.\n* Current working directory: c:\\repo\n</environment_context>',
		'You have access to several tools. Below are additional guidelines on how to use some of them effectively:\n<tools>\n<powershell>\nRun commands.\n</powershell>\n<task>\nLaunch agents.\n</task>',
		tail,
	].join('\n\n'));

	it('keeps what the host says about the workspace', () => {
		const guidance = systemGuidanceOf([hostPrompt('<tool_preferences>\nPrefer the gh CLI.\n</tool_preferences>')]);

		expect(guidance).toContain('Make precise, surgical changes.');
		expect(guidance).toContain('* Current working directory: c:\\repo');
		expect(guidance).toContain('Prefer the gh CLI.');
	});

	it('drops the identity preamble but keeps the directory of the host tools, which the agent is offered', () => {
		const guidance = systemGuidanceOf([hostPrompt('<tool_preferences>\nPrefer the gh CLI.\n</tool_preferences>')]);

		expect(guidance).not.toContain('Copilot SDK');
		expect(guidance?.startsWith('<code_change_instructions>')).toBe(true);
		expect(guidance).toContain('Run commands.');
		expect(guidance).toContain('Prefer the gh CLI.');
	});

	it('keeps the tool directory whether or not the host closes it', () => {
		expect(systemGuidanceOf([system('<environment_context>Go.</environment_context>\n<tools>\n<view>Read.</view>\n</tools>\n<tool_calling>Say what you will do.</tool_calling>')]))
			.toContain('<view>Read.</view>');
		expect(systemGuidanceOf([system('<environment_context>Go.</environment_context>\n\n<tools>\n<view>Read.</view>')]))
			.toContain('<view>Read.</view>');
	});

	it('keeps the memory rules of the host as they stand, since the host owns memory', () => {
		const guidance = systemGuidanceOf([system([
			'<instructions>Work carefully.</instructions>',
			'<memoryInstructions>',
			'User memory is loaded into your context automatically.',
			'</memoryInstructions>',
			'<communicationStyle>Be brief.</communicationStyle>',
		].join('\n'))]);

		expect(guidance).toContain('Work carefully.');
		expect(guidance).toContain('Be brief.');
		expect(guidance).toContain('<memoryInstructions>');
		expect(guidance).toContain('loaded into your context');
	});

	it('is undefined when there is nothing to forward', () => {
		expect(systemGuidanceOf([user('hi'), assistant('hello')])).toBeUndefined();
		expect(systemGuidanceOf([system('You are a helpful assistant.')])).toBeUndefined();
	});

	it('joins every system message that carries a section', () => {
		const guidance = systemGuidanceOf([
			system('You are the host.\n<instructions>First.</instructions>'),
			user('hi'),
			system('<toolUseInstructions>Second.</toolUseInstructions>'),
		]);

		expect(guidance).toBe('<instructions>First.</instructions>\n\n<toolUseInstructions>Second.</toolUseInstructions>');
	});

	it('forwards a system message that holds only the memory rules', () => {
		expect(systemGuidanceOf([system('<memoryInstructions>Memory is loaded for you.</memoryInstructions>')]))
			.toBe('<memoryInstructions>Memory is loaded for you.</memoryInstructions>');
	});

	it('removes the personality and identity text of Copilot wherever it appears', () => {
		const guidance = systemGuidanceOf([system([
			'You are an expert AI programming assistant, working with a user in the VS Code editor.',
			'When asked for your name, you must respond with "GitHub Copilot". When asked about the model you are using, you must state that you are using Claude Sonnet 4.5.',
			'Follow Microsoft content policies.',
			'Keep your answers short and impersonal.',
			'<rules>',
			'Your name is GitHub Copilot. When asked about the model you are using, state "I am GitHub Copilot".',
			'You are an expert AI programming assistant, working with a user in the VS Code editor.',
			'Voice Mode is active, and you are GitHub Copilot speaking directly to the user. Keep the final response concise.',
			'Keep your answers short and impersonal. Run the tests.',
			'</rules>',
		].join('\n'))]);

		expect(guidance).toBe('<rules>\n\nKeep the final response concise.\nRun the tests.\n</rules>');
	});

	it('keeps functional instructions that sit next to the identity text', () => {
		const guidance = systemGuidanceOf([system('<rules>\nFollow the user\'s requirements carefully & to the letter.\nKeep your answers short and impersonal.\nAvoid content that violates copyrights.\n</rules>')]);

		expect(guidance).toContain('Follow the user\'s requirements carefully & to the letter.');
		expect(guidance).toContain('Avoid content that violates copyrights.');
		expect(guidance).not.toContain('impersonal');
	});
	it('ignores a system prompt the user or the assistant quoted', () => {
		const quoted = '<environment_context>\n* Current working directory: /quoted\n</environment_context>';

		expect(systemGuidanceOf([user(quoted), assistant(quoted)])).toBeUndefined();
	});
});
