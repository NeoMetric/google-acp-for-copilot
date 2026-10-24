/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { AgentClient, CreateSessionOptions } from '../../src/agent';
import { McpBridge } from '../../src/bridge';
import { GoogleAcpProvider, guidanceDiffers, offersNewTools, sessionKey } from '../../src/provider';
import { assistant, system, toolResult, user } from './messages';
import { CancellationTokenSource, LanguageModelToolCallPart } from './vscode-mock';

describe('offersNewTools', () => {
	const tool = (name: string) => ({ name, description: '', inputSchema: { type: 'object' } });

	it('is false while Copilot offers the tools the session already saw', () => {
		expect(offersNewTools(new Set(['read_file', 'memory']), [tool('memory'), tool('read_file')])).toBe(false);
	});

	it('is true when Copilot offers a tool the session never saw', () => {
		expect(offersNewTools(new Set(['read_file']), [tool('read_file'), tool('task_complete')])).toBe(true);
	});

	it('ignores a tool the session no longer offers', () => {
		expect(offersNewTools(new Set(['read_file', 'memory']), [tool('read_file')])).toBe(false);
	});
});

describe('guidanceDiffers', () => {
	it('sees no change when only the casing or the spacing differs', () => {
		expect(guidanceDiffers('<instructions>Work on C:\\repo.</instructions>', '<instructions>Work   on c:\\repo.</instructions>')).toBe(false);
	});

	it('sees a change when the host now describes the chat differently', () => {
		expect(guidanceDiffers('<instructions>Ask.</instructions>', '<instructions>Work.</instructions>')).toBe(true);
	});

	it('sees a change when the host stops sending guidance', () => {
		expect(guidanceDiffers('<instructions>Work.</instructions>', undefined)).toBe(true);
	});
});

describe('sessionKey', () => {
	it('keeps one key as a chat grows', () => {
		const first = sessionKey([user('system'), user('fix the bug')]);
		const later = sessionKey([user('system'), user('fix the bug'), assistant('done'), user('thanks')]);

		expect(later).toBe(first);
	});

	it('keeps one key between turn 1 and turn 2 when opened with a real system message', () => {
		const turn1 = [system('You are an assistant.'), user('fix the bug')];
		const turn2 = [system('You are an assistant.'), user('fix the bug'), assistant('done'), user('thanks')];

		expect(sessionKey(turn2)).toBe(sessionKey(turn1));
	});

	it('separates chats that share a system prompt but open differently', () => {
		expect(sessionKey([user('system'), user('fix the bug')])).not.toBe(sessionKey([user('system'), user('write a test')]));
	});

	it('does not let a re-rendered system message start a new session', () => {
		const before = [system('Git repository root: C:\\repo'), user('fix the bug')];
		const after = [system('Git repository root: c:\\repo'), user('fix the bug')];

		expect(sessionKey(after)).toBe(sessionKey(before));
	});
});

const tools = [
	{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object', properties: {} } },
	{ name: 'grep', description: 'Searches files', inputSchema: { type: 'object', properties: {} } },
] as unknown as vscode.LanguageModelChatTool[];

const model = { id: 'gemini-test' } as vscode.LanguageModelChatInformation;

/** A stand-in for the agent process that hands its MCP endpoint to the test. */
class FakeAgent {

	readonly cancelled: string[] = [];
	private readonly endpoints: Array<{ url: string; authorization: string }> = [];
	private readonly finishes = new Map<string, () => void>();
	private prompted = false;
	private promptCalls = 0;
	private seq = 0;

	readonly onDidChange = () => ({ dispose() { } });

	async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; configOptions: never[] }> {
		const server = options.mcpServers[0];
		if (server) {
			this.endpoints.push({ url: server.url, authorization: server.headers[0].value });
		}
		return { sessionId: `acp-${++this.seq}`, configOptions: [] };
	}

	readonly closed: string[] = [];

	async closeSession(sessionId: string): Promise<void> {
		this.closed.push(sessionId);
	}

	async setConfigOption(): Promise<undefined> { return undefined; }

	/** The text of each prompt the provider sent, in order. */
	readonly promptTexts: string[] = [];

	cancel(sessionId: string): void {
		this.cancelled.push(sessionId);
		// A cancelled turn ends, as it does with the real agent.
		this.finishes.get(sessionId)?.();
		this.finishes.delete(sessionId);
	}

	/** Runs one turn that only ends when the test says so. */
	async prompt(sessionId: string, blocks: ReadonlyArray<{ type: string; text?: string }> = []): Promise<{ stopReason: string }> {
		this.prompted = true;
		this.promptCalls++;
		this.promptTexts.push(blocks.map(block => block.text ?? '').join('\n'));
		return new Promise(resolve => this.finishes.set(sessionId, () => resolve({ stopReason: 'end_turn' })));
	}

	finishTurn(sessionId = 'acp-1'): void {
		this.finishes.get(sessionId)?.();
		this.finishes.delete(sessionId);
	}

	get hasTurn(): boolean {
		return this.prompted;
	}

	/** How many turns the provider has started, so a new one can be awaited. */
	get prompts(): number {
		return this.promptCalls;
	}

	/** How many ACP sessions the provider opened, so a rebuild can be spotted. */
	get sessionCount(): number {
		return this.endpoints.length;
	}

	get endpoint(): { url: string; authorization: string } {
		const endpoint = this.endpoints[0];
		if (!endpoint) {
			throw new Error('The provider has not created a session yet.');
		}
		return endpoint;
	}

	get created(): boolean {
		return this.endpoints.length > 0;
	}
}

const options = { tools } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

function silentOutput(): vscode.LogOutputChannel {
	return { debug() { }, info() { }, warn() { }, error() { }, show() { } } as unknown as vscode.LogOutputChannel;
}

interface Recorder extends vscode.Progress<vscode.LanguageModelResponsePart> {
	readonly parts: vscode.LanguageModelResponsePart[];
}

function recorder(): Recorder {
	const parts: vscode.LanguageModelResponsePart[] = [];
	return { parts, report: (part: vscode.LanguageModelResponsePart) => { parts.push(part); } };
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error('Timed out waiting for the provider.');
		}
		await delay(5);
	}
}

const toolCallsOf = (recorder: Recorder) =>
	recorder.parts.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof LanguageModelToolCallPart);

describe('GoogleAcpProvider tool calls', () => {
	let bridge: McpBridge;
	let provider: GoogleAcpProvider;
	let agent: FakeAgent;

	beforeEach(() => {
		agent = new FakeAgent();
		bridge = new McpBridge(() => { });
		provider = new GoogleAcpProvider(agent as unknown as AgentClient, bridge, silentOutput());
	});

	afterEach(() => {
		provider.dispose();
		bridge.dispose();
	});

	/** Asks the bridge for a tool, as the agent does; the promise settles with the tool result. */
	const callTool = async (name: string, args: unknown) => {
		await waitFor(() => agent.created);
		const response = await fetch(agent.endpoint.url, {
			method: 'POST',
			headers: { authorization: agent.endpoint.authorization, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
		});
		return await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
	};

	const request = (messages: vscode.LanguageModelChatRequestMessage[], token: vscode.CancellationToken) => {
		const progress = recorder();
		const response = provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
		return { progress, response };
	};

	it('holds a tool call that arrives after its response returned for the next one', async () => {
		const token = new CancellationTokenSource();
		const history = [user('system'), user('hello')];

		const first = request(history, token.token);
		const firstResult = callTool('read_file', { path: 'a.txt' });
		await waitFor(() => toolCallsOf(first.progress).length === 1);
		await first.response;

		const [firstCall] = toolCallsOf(first.progress);
		expect(firstCall.name).toBe('read_file');

		// The agent asks for another tool while Copilot runs the first one: no response
		// can carry it yet, so it has to wait for the next one instead of failing.
		const heldResult = callTool('grep', { pattern: 'x' });
		// A refused call answers at once; a held one waits for the next response.
		expect(await Promise.race([heldResult.then(() => 'settled'), delay(50).then(() => 'waiting')])).toBe('waiting');

		history.push(assistant('working'), user(toolResult(firstCall.callId)));
		const second = request(history, token.token);
		await second.response;

		const [heldCall] = toolCallsOf(second.progress);
		expect(heldCall.name).toBe('grep');
		expect((await firstResult).result).toEqual({ content: [{ type: 'text', text: 'output' }] });

		// Copilot ran the held call too, so the agent gets its result as well.
		history.push(assistant('working'), user(toolResult(heldCall.callId)));
		const third = request(history, token.token);
		expect((await heldResult).result).toEqual({ content: [{ type: 'text', text: 'output' }] });

		agent.finishTurn();
		await third.response;
	});

	it('cancels the turn when Copilot cancels the request that handed a tool over', async () => {
		const token = new CancellationTokenSource();

		const first = request([user('system'), user('hello')], token.token);
		const result = callTool('read_file', { path: 'a.txt' });
		await waitFor(() => toolCallsOf(first.progress).length === 1);
		await first.response;

		// The user stopped the chat: the tool call is still waiting for a result that
		// will never come, and the agent must not wait three minutes for it.
		token.cancel();

		expect(agent.cancelled).toEqual(['acp-1']);
		expect((await result).result.isError).toBe(true);
		expect((await result).result.content[0].text).toContain('cancelled');
	});

	it('sends a message typed while a tool ran as a new prompt in the same session', async () => {
		const token = new CancellationTokenSource();
		const history = [user('system'), user('hello')];

		const first = request(history, token.token);
		const result = callTool('read_file', { path: 'a.txt' });
		await waitFor(() => toolCallsOf(first.progress).length === 1);
		await first.response;
		const [call] = toolCallsOf(first.progress);

		history.push(assistant('working'), user(toolResult(call.callId), 'wait, use b.txt instead'));
		const second = request(history, token.token);
		await waitFor(() => agent.prompts === 2);

		expect(agent.cancelled).toEqual(['acp-1']);
		expect(agent.sessionCount).toBe(1);
		expect((await result).result.isError).toBe(true);
		expect(agent.promptTexts[1]).toBe('wait, use b.txt instead');

		agent.finishTurn();
		await second.response;
	});

	it('continues the running turn for the result of a call the agent already gave up on', async () => {
		const token = new CancellationTokenSource();
		const history = [user('system'), user('hello')];

		const first = request(history, token.token);
		const result = callTool('read_file', { path: 'a.txt' });
		await waitFor(() => toolCallsOf(first.progress).length === 1);
		await first.response;
		const [call] = toolCallsOf(first.progress);

		// The call is settled on the agent's side, so the result has nothing to answer.
		(provider as unknown as { sessions: Map<string, { turn: { pending: Map<string, unknown> } }> }).sessions.forEach(session => session.turn.pending.clear());
		void result;

		history.push(assistant('working'), user(toolResult(call.callId)));
		const second = request(history, token.token);
		await delay(50);

		expect(agent.cancelled).toEqual([]);
		expect(agent.prompts).toBe(1);

		agent.finishTurn();
		await second.response;
	});

	it('does not send the first message again after an abandoned turn', async () => {
		const token = new CancellationTokenSource();
		const history = [user('system'), user('hello')];

		const first = request(history, token.token);
		void callTool('read_file', { path: 'a.txt' });
		await waitFor(() => toolCallsOf(first.progress).length === 1);
		await first.response;
		const [call] = toolCallsOf(first.progress);

		history.push(assistant('working'), user(toolResult(call.callId), 'stop'));
		const second = request(history, token.token);
		await waitFor(() => agent.prompts === 2);
		agent.finishTurn();
		await second.response;

		history.push(assistant('ok'), user('thanks'));
		const third = request(history, token.token);
		await waitFor(() => agent.prompts === 3);

		expect(agent.sessionCount).toBe(1);
		expect(agent.promptTexts[2]).toBe('thanks');

		agent.finishTurn();
		await third.response;
	});

	it('refuses a tool call once its turn has ended', async () => {
		const first = request([user('system'), user('hello')], new CancellationTokenSource().token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first.response;

		const late = await callTool('read_file', { path: 'a.txt' });

		expect(late.result.isError).toBe(true);
		expect(late.result.content[0].text).toContain('cannot run right now');
	});

	it('emits cache stats on turn completion when token usage is available', async () => {
		const statsList: any[] = [];
		provider.onDidChangeCacheStats(stats => statsList.push(stats));

		// Mock prompt to return token usage
		(agent as any).prompt = async (_sessionId: string) => {
			return {
				stopReason: 'end_turn',
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					cachedReadTokens: 400,
					cachedWriteTokens: 0,
					totalTokens: 550,
				},
			};
		};

		const first = request([user('system'), user('hello')], new CancellationTokenSource().token);
		await first.response;

		expect(statsList.length).toBe(1);
		expect(statsList[0]).toEqual({
			hitRate: 80, // 400 / (400 + 100) * 100%
			cachedTokens: 400,
			uncachedTokens: 100,
			totalPromptTokens: 500,
			outputTokens: 50,
			model: 'gemini-test',
		});
	});

	/** The tools the agent can see right now, as the bridge lists them. */
	const listedTools = async () => {
		const response = await fetch(agent.endpoint.url, {
			method: 'POST',
			headers: { authorization: agent.endpoint.authorization, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
		});
		const body = await response.json() as { result: { tools: Array<{ name: string }> } };
		return body.result.tools.map(tool => tool.name);
	};

	it('ignores the empty tool set of a request Copilot made for itself', async () => {
		const token = new CancellationTokenSource();
		const opening = [user('system'), user('hello')];
		const first = request(opening, token.token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first.response;

		// A chat title arrives with no tools; it says nothing about what the chat may use.
		const title = { tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
		const titled = provider.provideLanguageModelChatResponse(model, [...opening, assistant('ok'), user('go on')], title, recorder(), token.token);
		await waitFor(() => agent.prompts === 2);
		const listed = await listedTools();
		agent.finishTurn();
		await titled;

		expect(listed).toEqual(['read_file', 'grep']);
		expect(agent.sessionCount).toBe(1);
	});

	it('gives a chat that opened without tools a session with the workspace prompt', async () => {
		provider.dispose();
		const promptTools: number[] = [];
		provider = new GoogleAcpProvider(agent as unknown as AgentClient, bridge, silentOutput(), undefined, async (sessionTools) => {
			promptTools.push(sessionTools.length);
			return 'appended';
		});

		const token = new CancellationTokenSource();
		const opening = [user('system'), user('hello')];
		const title = { tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
		const titled = provider.provideLanguageModelChatResponse(model, opening, title, recorder(), token.token);
		await waitFor(() => agent.prompts === 1);
		agent.finishTurn();
		await titled;

		expect(promptTools).toEqual([]);

		const worked = provider.provideLanguageModelChatResponse(model, [...opening, assistant('ok'), user('the real work')], options, recorder(), token.token);
		await waitFor(() => agent.prompts === 2);
		agent.finishTurn('acp-2');
		await worked;

		expect(promptTools).toEqual([2]);
		expect(agent.sessionCount).toBe(2);
	});

	it('gives the chat a new session when Copilot starts offering a tool it never saw', async () => {
		const token = new CancellationTokenSource();
		const opening = [user('system'), user('hello')];
		const first = request(opening, token.token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first.response;

		const more = { tools: [...tools, { name: 'task_complete', description: 'Finishes', inputSchema: { type: 'object' } }] } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
		const second = provider.provideLanguageModelChatResponse(model, [...opening, assistant('ok'), user('go on')], more, recorder(), token.token);
		await waitFor(() => agent.prompts === 2);
		agent.finishTurn('acp-2');
		await second;

		expect(agent.sessionCount).toBe(2);
	});

	it('gives the chat a new session when the host describes it differently', async () => {
		const token = new CancellationTokenSource();
		const opening = [system('<instructions>Ask before changing anything.</instructions>'), user('hello')];
		const first = provider.provideLanguageModelChatResponse(model, opening, options, recorder(), token.token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first;

		const changed = [system('<instructions>Make the change now.</instructions>'), user('hello')];
		const second = provider.provideLanguageModelChatResponse(model, [...changed, assistant('ok'), user('go on')], options, recorder(), token.token);
		await waitFor(() => agent.prompts === 2);
		agent.finishTurn('acp-2');
		await second;

		expect(agent.sessionCount).toBe(2);
	});

	it('reuses the session between turn 1 and turn 2 when the chat continues normally', async () => {
		const token = new CancellationTokenSource();
		const turn1 = [system('<instructions>Be helpful.</instructions>'), user('hello')];
		const first = provider.provideLanguageModelChatResponse(model, turn1, options, recorder(), token.token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first;

		const turn2 = [...turn1, assistant('hi'), user('how are you?')];
		const second = provider.provideLanguageModelChatResponse(model, turn2, options, recorder(), token.token);
		await waitFor(() => agent.prompts === 2);
		agent.finishTurn('acp-1');
		await second;

		expect(agent.sessionCount).toBe(1);
	});

	it('closes all sessions and cancels active turns when closeAllSessions is called', async () => {
		const token = new CancellationTokenSource();
		const turn = [system('<instructions>Be helpful.</instructions>'), user('hello')];
		const response = provider.provideLanguageModelChatResponse(model, turn, options, recorder(), token.token);
		await waitFor(() => agent.hasTurn);

		await provider.closeAllSessions();
		expect(agent.cancelled).toContain('acp-1');
		expect(agent.closed).toContain('acp-1');
		agent.finishTurn();
		await response.catch(() => undefined);
	});
});
