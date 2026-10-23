/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { AgentClient, CreateSessionOptions } from '../../src/agent';
import { McpBridge } from '../../src/bridge';
import { GoogleAcpProvider, sessionKey } from '../../src/provider';
import { assistant, toolResult, user } from './messages';
import { CancellationTokenSource, LanguageModelToolCallPart } from './vscode-mock';

describe('sessionKey', () => {
	it('keeps one key as a chat grows', () => {
		const first = sessionKey([user('system'), user('fix the bug')]);
		const later = sessionKey([user('system'), user('fix the bug'), assistant('done'), user('thanks')]);

		expect(later).toBe(first);
	});

	it('separates chats that share a system prompt but open differently', () => {
		expect(sessionKey([user('system'), user('fix the bug')])).not.toBe(sessionKey([user('system'), user('write a test')]));
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
	private seq = 0;

	readonly onDidChange = () => ({ dispose() { } });

	async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; configOptions: never[] }> {
		const server = options.mcpServers[0];
		if (server) {
			this.endpoints.push({ url: server.url, authorization: server.headers[0].value });
		}
		return { sessionId: `acp-${++this.seq}`, configOptions: [] };
	}

	async closeSession(): Promise<void> { }

	async setConfigOption(): Promise<undefined> { return undefined; }

	cancel(sessionId: string): void {
		this.cancelled.push(sessionId);
	}

	/** Runs one turn that only ends when the test says so. */
	async prompt(sessionId: string): Promise<{ stopReason: string }> {
		this.prompted = true;
		return new Promise(resolve => this.finishes.set(sessionId, () => resolve({ stopReason: 'end_turn' })));
	}

	finishTurn(sessionId = 'acp-1'): void {
		this.finishes.get(sessionId)?.();
		this.finishes.delete(sessionId);
	}

	get hasTurn(): boolean {
		return this.prompted;
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

	it('refuses a tool call once its turn has ended', async () => {
		const first = request([user('system'), user('hello')], new CancellationTokenSource().token);
		await waitFor(() => agent.hasTurn);
		agent.finishTurn();
		await first.response;

		const late = await callTool('read_file', { path: 'a.txt' });

		expect(late.result.isError).toBe(true);
		expect(late.result.content[0].text).toContain('cannot run right now');
	});
});
