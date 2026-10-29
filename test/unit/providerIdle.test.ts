/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AgentClient } from '../../src/agent';
import { GoogleAcpProvider } from '../../src/provider';
import { assistant, user } from './messages';
import { CancellationTokenSource, configValues } from './vscode-mock';

interface StartedPrompt {
	finish(): void;
}

/** Just enough of the agent: it opens and closes sessions, and a prompt runs until the test finishes it. */
class FakeAgent {
	readonly prompts: StartedPrompt[] = [];
	readonly requiresSignIn = false;
	readonly closed: string[] = [];
	stops = 0;
	private sessions = 0;

	get isRunning(): boolean {
		return this.stops === 0;
	}

	async stopWhenIdle(): Promise<void> {
		this.stops++;
	}

	readonly onDidChange = () => ({ dispose() { } });

	async ensureStarted(): Promise<void> { }

	async createSession(): Promise<{ sessionId: string; configOptions: never[] }> {
		return { sessionId: `s${++this.sessions}`, configOptions: [] };
	}

	prompt(): Promise<{ stopReason: string }> {
		return new Promise(resolve => {
			this.prompts.push({ finish: () => resolve({ stopReason: 'end_turn' }) });
		});
	}

	cancel(): void { }

	async setConfigOption(): Promise<undefined> {
		return undefined;
	}

	async closeSession(sessionId: string): Promise<void> {
		this.closed.push(sessionId);
	}
}

class FakeBridge {
	async registerSession(): Promise<{ url: string; token: string }> {
		return { url: 'http://127.0.0.1:1/mcp', token: 'token' };
	}

	unregisterSession(): void { }
	updateTools(): void { }
}

const model = { id: 'gemini-test' } as vscode.LanguageModelChatInformation;
const tool = { name: 'ask_user', description: 'Ask the user.', inputSchema: {} } as vscode.LanguageModelChatTool;
const options = { tools: [tool], modelOptions: { _conversationId: 'chat-1' } } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

const MINUTE = 60_000;
const IDLE_KEY = 'googleAcp.sessions.idleTimeoutSeconds';

let agent: FakeAgent;
let provider: GoogleAcpProvider;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	agent = new FakeAgent();
	const output = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	provider = new GoogleAcpProvider(agent as unknown as AgentClient, new FakeBridge() as never, output as never);
});

afterEach(() => {
	provider.dispose();
	delete configValues[IDLE_KEY];
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function respond(messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<void> {
	const progress = { report: () => { } } as vscode.Progress<vscode.LanguageModelResponsePart>;
	return provider.provideLanguageModelChatResponse(model, messages, options, progress, new CancellationTokenSource().token);
}

const opening = () => [user('Project notes'), user('Hello')];

/** Runs one whole turn of the chat, which leaves its session open. */
async function finishTurn(messages: readonly vscode.LanguageModelChatRequestMessage[], promptNumber: number): Promise<void> {
	const done = respond(messages);
	await vi.waitFor(() => expect(agent.prompts).toHaveLength(promptNumber));
	agent.prompts[promptNumber - 1].finish();
	await done;
}

describe('an idle chat session', () => {
	it('is released after the idle time', async () => {
		await finishTurn(opening(), 1);

		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(agent.closed).toEqual([]);

		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		expect(agent.closed).toEqual(['s1']);
	});

	it('is replaced by a new session on the next message', async () => {
		await finishTurn(opening(), 1);
		await vi.advanceTimersByTimeAsync(3 * MINUTE);

		await finishTurn([...opening(), assistant('Hi'), user('And now?')], 2);

		expect(agent.closed).toEqual(['s1']);
		await vi.advanceTimersByTimeAsync(0);
		expect(agent.prompts).toHaveLength(2);
	});

	it('stays while the chat keeps asking for things', async () => {
		await finishTurn(opening(), 1);
		await vi.advanceTimersByTimeAsync(MINUTE);
		await finishTurn([...opening(), assistant('Hi'), user('Again')], 2);

		await vi.advanceTimersByTimeAsync(MINUTE + 30_000);

		expect(agent.closed).toEqual([]);
	});

	it('is kept while its turn is running', async () => {
		const done = respond(opening());
		await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(agent.closed).toEqual([]);

		agent.prompts[0].finish();
		await done;
	});

	it('is kept when the idle time is turned off', async () => {
		configValues[IDLE_KEY] = 0;
		await finishTurn(opening(), 1);

		await vi.advanceTimersByTimeAsync(30 * MINUTE);

		expect(agent.closed).toEqual([]);
	});
});

describe('the agent process', () => {
	const SHUTDOWN_KEY = 'googleAcp.agent.idleShutdownMinutes';

	afterEach(() => {
		delete configValues[SHUTDOWN_KEY];
	});

	it('is stopped once no chat session is left for the idle shutdown time', async () => {
		await finishTurn(opening(), 1);

		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(agent.closed).toEqual(['s1']);
		expect(agent.stops).toBe(0);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(agent.stops).toBe(0);

		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		expect(agent.stops).toBe(1);
	});

	it('is kept while a chat still has a session', async () => {
		configValues[IDLE_KEY] = 0;
		await finishTurn(opening(), 1);

		await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);

		expect(agent.stops).toBe(0);
	});

	it('is kept when the idle shutdown is turned off', async () => {
		configValues[SHUTDOWN_KEY] = 0;
		await finishTurn(opening(), 1);

		await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);

		expect(agent.closed).toEqual(['s1']);
		expect(agent.stops).toBe(0);
	});

	it('is kept while a request keeps coming in', async () => {
		await finishTurn(opening(), 1);
		await vi.advanceTimersByTimeAsync(25 * MINUTE);
		await finishTurn([...opening(), assistant('Hi'), user('Back again')], 2);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);

		expect(agent.stops).toBe(0);
	});
});

describe('the session that reads models', () => {
	it('is closed once it has been unused for a while', async () => {
		await provider.provideLanguageModelChatInformation({ silent: true }, new CancellationTokenSource().token);
		expect(agent.closed).toEqual([]);

		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(agent.closed).toEqual(['s1']);
	});
});
