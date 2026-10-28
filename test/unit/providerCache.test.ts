/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AcpContentBlock } from '../../src/convert';
import type { AgentClient } from '../../src/agent';
import { GoogleAcpProvider } from '../../src/provider';
import { buildSystemPromptAppend } from '../../src/systemPrompt';
import { assistant, system, user } from './messages';
import { CancellationTokenSource } from './vscode-mock';

/** The agent records what it is given: the options of each session and the blocks of each turn. */
class FakeAgent {
	readonly requiresSignIn = false;
	readonly sessions: { systemPromptAppend?: string }[] = [];
	readonly turns: AcpContentBlock[][] = [];

	readonly onDidChange = () => ({ dispose() { } });

	async ensureStarted(): Promise<void> { }

	async createSession(options: { systemPromptAppend?: string }): Promise<{ sessionId: string; configOptions: never[] }> {
		this.sessions.push(options);
		return { sessionId: `s${this.sessions.length}`, configOptions: [] };
	}

	async prompt(_sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
		this.turns.push(blocks);
		return { stopReason: 'end_turn' };
	}

	cancel(): void { }

	async setConfigOption(): Promise<undefined> {
		return undefined;
	}

	async closeSession(): Promise<void> { }
}

class FakeBridge {
	async registerSession(): Promise<{ url: string; token: string }> {
		return { url: 'http://127.0.0.1:1/mcp', token: 'token' };
	}

	unregisterSession(): void { }
	updateTools(): void { }
}

const model = { id: 'gemini-test' } as vscode.LanguageModelChatInformation;
const toolA = { name: 'read_file', description: 'Read.', inputSchema: { required: ['path'] } } as vscode.LanguageModelChatTool;
const toolB = { name: 'apply_patch', description: 'Patch.', inputSchema: { required: ['input'] } } as vscode.LanguageModelChatTool;

const SYSTEM = 'You are an expert AI programming assistant.\n<rules>\nRun the tests.\n</rules>';
const INSTRUCTIONS = 'When generating code, please follow these user provided coding instructions. You can ignore an instruction if it contradicts a system message.\n<instructions>\nUse tabs.\n</instructions>';
const MODE = '<modeInstructions>\nYou are currently running in "Plan" mode.\n</modeInstructions>';
const ENVIRONMENT = '<environment_info>Windows</environment_info>\n<workspace_info>c:\\repo</workspace_info>';

const firstTurn = () => [user(`${ENVIRONMENT}\n${INSTRUCTIONS}\n${MODE}`), user('<context>The current date is 2026-10-28.</context><userRequest>one</userRequest>')];
const laterTurn = (request: string, date: string) => user(`${INSTRUCTIONS}\n${MODE}\n<context>The current date is ${date}.</context><userRequest>${request}</userRequest>`);

function setUp() {
	const agent = new FakeAgent();
	const output = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const sessionPrompt = async (tools: readonly vscode.LanguageModelChatTool[], _folders?: readonly string[], guidance?: string) =>
		buildSystemPromptAppend({ guidance, toolArguments: tools.map(tool => ({ name: tool.name, required: (tool.inputSchema as { required: string[] }).required })) });
	const provider = new GoogleAcpProvider(agent as unknown as AgentClient, new FakeBridge() as never, output as never, undefined, sessionPrompt);
	const respond = (messages: readonly vscode.LanguageModelChatRequestMessage[], tools: readonly vscode.LanguageModelChatTool[]) =>
		provider.provideLanguageModelChatResponse(
			model,
			messages,
			{ tools, modelOptions: { _conversationId: 'chat-1' } } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
			{ report: () => { } } as vscode.Progress<vscode.LanguageModelResponsePart>,
			new CancellationTokenSource().token,
		);
	return { agent, provider, respond };
}

const textOfTurn = (blocks: readonly AcpContentBlock[]) => blocks.map(block => block.type === 'text' ? block.text : '').join('\n');
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('the prompt over consecutive turns', () => {
	it('keeps the system prompt and the tool list the same bytes, and opens one session', async () => {
		const { agent, provider, respond } = setUp();
		const opening = [system(SYSTEM), ...firstTurn()];
		await respond(opening, [toolA, toolB]);
		const second = [...opening, assistant('ok'), laterTurn('two', '2026-10-28')];
		await respond(second, [toolB, toolA]);
		await respond([...second, assistant('ok'), laterTurn('three', '2026-10-29')], [toolA, toolB]);

		expect(agent.sessions).toHaveLength(1);
		expect(agent.turns).toHaveLength(3);
		const append = agent.sessions[0].systemPromptAppend ?? '';
		expect(append).toContain('<rules>');
		expect(append.indexOf('apply_patch')).toBeLessThan(append.indexOf('read_file'));
		expect(append).not.toMatch(/2026-10-2\d|Plan|Use tabs/);
		provider.dispose();
	});

	it('builds the same append bytes for the same chat in any tool order', async () => {
		const build = async (tools: vscode.LanguageModelChatTool[]) => {
			const { agent, provider, respond } = setUp();
			await respond([system(SYSTEM), ...firstTurn()], tools);
			provider.dispose();
			return agent.sessions[0].systemPromptAppend;
		};

		expect(await build([toolA, toolB])).toBe(await build([toolB, toolA]));
	});

	it('sends no part of the guidance, the context or the instructions more than once', async () => {
		const { agent, provider, respond } = setUp();
		const opening = [system(SYSTEM), ...firstTurn()];
		await respond(opening, [toolA, toolB]);
		const second = [...opening, assistant('ok'), laterTurn('two', '2026-10-29')];
		await respond(second, [toolA, toolB]);
		await respond([...second, assistant('ok'), laterTurn('three', '2026-10-30')], [toolA, toolB]);

		const append = agent.sessions[0].systemPromptAppend ?? '';
		const turns = agent.turns.map(textOfTurn);
		expect(count(append, 'Run the tests.')).toBe(1);
		expect(count(append, 'You are running inside Visual Studio Code')).toBe(1);
		expect(count(append, 'expert AI programming assistant')).toBe(0);
		for (const needle of ['Use tabs.', 'Plan', 'Windows']) {
			expect(turns.map(turn => count(turn, needle)).reduce((a, b) => a + b, 0)).toBe(1);
			expect(append).not.toContain(needle);
		}
		expect(turns[0]).toContain('Use tabs.');
		expect(turns[1]).not.toContain('Use tabs.');
		expect(turns[2]).not.toContain('Use tabs.');
		expect(turns[1]).toContain('The current date is 2026-10-29.');
		expect(turns[2]).toContain('three');
		provider.dispose();
	});

	it('sends the instructions again when the mode changes, and only then', async () => {
		const { agent, provider, respond } = setUp();
		const opening = [system(SYSTEM), ...firstTurn()];
		await respond(opening, [toolA]);
		const agentMode = '<modeInstructions>\nYou are currently running in "Agent" mode.\n</modeInstructions>';
		const second = [...opening, assistant('ok'), user(`${INSTRUCTIONS}\n${agentMode}\n<userRequest>two</userRequest>`)];
		await respond(second, [toolA]);

		expect(agent.sessions).toHaveLength(1);
		expect(textOfTurn(agent.turns[1])).toContain('"Agent" mode');
		provider.dispose();
	});
});
