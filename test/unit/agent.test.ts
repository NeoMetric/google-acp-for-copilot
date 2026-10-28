/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AgentClient, AgentNotFoundError, describeAgent, readTokenUsage, type AgentChange } from '../../src/agent';
import { ApiKeyStore } from '../../src/auth';
import { RpcConnectionClosedError } from '../../src/rpc';
import { launchSpecFor } from '../../src/launch';
import { FakeSecretStorage } from './secrets';
import { configValues } from './vscode-mock';

const repoRoot = path.resolve(__dirname, '..', '..');
const API_KEY_SECRET = 'googleAcp.geminiApiKey';
/** Stopping the agent runs `taskkill` on Windows, which can take a couple of seconds. */
const SLOW_KILL_TIMEOUT_MS = 30_000;

let temp: string;
let agent: AgentClient | undefined;
let secrets: FakeSecretStorage;
let output: { [level: string]: ReturnType<typeof vi.fn> };
const savedApiKey = process.env.GEMINI_API_KEY;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-acp-agent-'));
	secrets = new FakeSecretStorage();
	delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
	agent?.dispose();
	agent = undefined;
	delete process.env.FAKE_ACP_MODE;
	for (const key of Object.keys(configValues)) {
		delete configValues[key];
	}
	if (savedApiKey === undefined) {
		delete process.env.GEMINI_API_KEY;
	} else {
		process.env.GEMINI_API_KEY = savedApiKey;
	}
	vi.restoreAllMocks();
	fs.rmSync(temp, { recursive: true, force: true });
});

/** Points the settings at the fake ACP server, started with the node that runs the tests. */
function useFakeAgent(): void {
	configValues['googleAcp.agent.command'] = process.execPath;
	configValues['googleAcp.agent.args'] = [path.join(__dirname, 'fake-agent.cjs')];
}

function createAgent(options: { install: boolean } = { install: true }): AgentClient {
	const storage = path.join(temp, 'storage');
	fs.mkdirSync(storage, { recursive: true });
	if (options.install) {
		useFakeAgent();
	} else {
		configValues['googleAcp.agent.command'] = path.join(temp, 'no-such-program');
	}
	const context = {
		globalStorageUri: { fsPath: storage },
		extensionPath: repoRoot,
		extension: { packageJSON: { version: '0.0.0' } },
	} as unknown as vscode.ExtensionContext;
	output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

	agent = new AgentClient(context, output as unknown as vscode.LogOutputChannel, new ApiKeyStore(secrets.asSecretStorage()));
	return agent;
}

/** Runs a turn that makes the fake agent report the API key it was started with. */
async function reportedKey(client: AgentClient): Promise<string> {
	const session = await client.createSession({ cwd: temp, mcpServers: [] });
	let reply = '';
	await client.prompt(session.sessionId, [{ type: 'text', text: 'env' }], { onText: text => { reply += text; } });
	return reply;
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe('AgentClient', () => {
	it('starts the agent, opens a session and streams a turn', async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		const chunks: string[] = [];

		const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'hello' }], { onText: text => chunks.push(text) });

		expect(session.configOptions).toHaveLength(1);
		expect(chunks).toEqual(['echo:hello']);
		expect(result.stopReason).toBe('end_turn');
		expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
	});

	it('turns off the built-in tools and appends the system prompt when a session starts', async () => {
		const client = createAgent();
		await client.createSession({ cwd: temp, mcpServers: [], systemPromptAppend: 'Be brief.' });

		const logged = output.debug.mock.calls.map(call => String(call[0])).find(line => line.includes('session/new response _meta'));
		expect(logged).toContain('"disabledTools":["run_command"');
		expect(logged).toContain('"systemPrompt":{"append":"Be brief."}');
	});

	it('fails the session instead of retrying without the options the server refused', async () => {
		process.env.FAKE_ACP_MODE = 'reject-meta';
		const client = createAgent();

		await expect(client.createSession({ cwd: temp, mcpServers: [], systemPromptAppend: 'Be brief.' }))
			.rejects.toThrow(/refused the session options/);
	});

	it('resumes a stored session with the prompt it was opened with', async () => {
		const client = createAgent();
		const options = { cwd: temp, mcpServers: [], systemPromptAppend: 'Be brief.' };
		const created = await client.createSession(options);
		const resumed = await client.resumeSession(created.sessionId, options);

		expect(resumed.sessionId).toBe(created.sessionId);
		const logged = output.debug.mock.calls.map(call => String(call[0])).find(line => line.includes('session/resume response _meta'));
		expect(logged).toContain('"systemPrompt":{"append":"Be brief."}');
	});

	it('reports a session the agent no longer has instead of creating one', async () => {
		process.env.FAKE_ACP_MODE = 'reject-resume';
		const client = createAgent();

		await expect(client.resumeSession('gone', { cwd: temp, mcpServers: [] })).rejects.toThrow(/unknown session/);
	});

	it('closes a session cleanly', async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		await expect(client.closeSession(session.sessionId)).resolves.toBeUndefined();
	});

	it('answers permission requests by itself in auto mode', async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });

		const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'permission' }], { onText: () => { } });

		expect(result.stopReason).toBe('permission:{"outcome":"selected","optionId":"allow-1"}');
	});

	it("declines permission requests for the agent's own tools", async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });

		const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'native-permission' }], { onText: () => { } });

		expect(result.stopReason).toBe('permission:{"outcome":"selected","optionId":"reject-1"}');
	});

	it('turns a usage-limit error into a clear one and reports the limit', async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		const limits: Array<unknown> = [];
		client.onDidChangeLimit(limit => limits.push(limit));

		await expect(client.prompt(session.sessionId, [{ type: 'text', text: 'quota' }], { onText: () => { } })).rejects.toThrow('usage limit is reached. It resets in 2h');

		expect(client.currentLimit?.resetAt).toBeGreaterThan(Date.now());
		expect(limits).toHaveLength(1);

		await client.prompt(session.sessionId, [{ type: 'text', text: 'hello' }], { onText: () => { } });
		expect(client.currentLimit).toBeUndefined();
		expect(limits).toHaveLength(2);
	});

	it('reports a missing ACP server program', async () => {
		const client = createAgent({ install: false });

		expect(await client.isInstalled()).toBe(false);
		await expect(client.ensureStarted({ silent: true })).rejects.toBeInstanceOf(AgentNotFoundError);
	});

	it('recovers on its own after the process dies mid-turn', async () => {
		const client = createAgent();
		const changes: AgentChange[] = [];
		client.onDidChange(change => changes.push(change));
		const first = await client.createSession({ cwd: temp, mcpServers: [] });

		await expect(client.prompt(first.sessionId, [{ type: 'text', text: 'crash' }], { onText: () => { } })).rejects.toBeInstanceOf(RpcConnectionClosedError);
		await vi.waitFor(() => expect(changes).toEqual(['exited']));

		// The sessions died with the process; the next one is created in a fresh process.
		const second = await client.createSession({ cwd: temp, mcpServers: [] });
		const chunks: string[] = [];
		await client.prompt(second.sessionId, [{ type: 'text', text: 'again' }], { onText: text => chunks.push(text) });
		expect(second.sessionId).toBe('s1');
		expect(chunks).toEqual(['echo:again']);
	});

	it('reports a deliberate restart as such', async () => {
		const client = createAgent();
		const changes: AgentChange[] = [];
		client.onDidChange(change => changes.push(change));
		await client.ensureStarted();

		await client.restart();

		expect(changes).toEqual(['restarted']);
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		expect(session.sessionId).toBe('s1');
	});

	it('stops starting an agent that keeps dying, until it is restarted by hand', async () => {
		const client = createAgent();
		process.env.FAKE_ACP_MODE = 'exit-immediately';

		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(client.ensureStarted()).rejects.toBeInstanceOf(Error);
			await vi.waitFor(() => expect((client as unknown as { child?: unknown }).child).toBeUndefined());
		}
		await expect(client.ensureStarted()).rejects.toThrow('keeps stopping');

		delete process.env.FAKE_ACP_MODE;
		await client.restart();
		await expect(client.ensureStarted()).resolves.toBeDefined();
	}, SLOW_KILL_TIMEOUT_MS);

	it('starts without an API key by default', async () => {
		const client = createAgent();

		expect(await reportedKey(client)).toBe('env:none');
		expect(client.usesApiKey).toBe(false);
	});

	it('hands a saved API key to the agent, and keeps it out of the log', async () => {
		const client = createAgent();
		expect(await reportedKey(client)).toBe('env:none');
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('AIza-secret-123');

		await client.setApiKey();

		expect(await reportedKey(client)).toBe('env:AIza-secret-123');
		await vi.waitFor(() => expect(client.usesApiKey).toBe(true));
		expect(JSON.stringify(Object.values(output).map(fn => fn.mock.calls))).not.toContain('AIza-secret-123');
	});

	it('goes back to no key once the saved one is removed', async () => {
		const client = createAgent();
		await secrets.store(API_KEY_SECRET, 'AIza-secret-456');
		expect(await reportedKey(client)).toBe('env:AIza-secret-456');

		await client.removeApiKey();

		expect(await reportedKey(client)).toBe('env:none');
	});

	it('lets a saved key win over one in the environment', async () => {
		process.env.GEMINI_API_KEY = 'AIza-from-env';
		const client = createAgent();
		expect(await reportedKey(client)).toBe('env:AIza-from-env');

		await secrets.store(API_KEY_SECRET, 'AIza-saved');
		await vi.waitFor(async () => expect(await reportedKey(client)).toBe('env:AIza-saved'));
	});

	it('restarts when another window saves a key, and only once', async () => {
		const client = createAgent();
		const changes: AgentChange[] = [];
		client.onDidChange(change => changes.push(change));
		await client.ensureStarted();

		secrets.storeFromElsewhere(API_KEY_SECRET, 'AIza-other-window');
		await vi.waitFor(() => expect(changes).toEqual(['restarted']), { timeout: SLOW_KILL_TIMEOUT_MS });

		expect(await reportedKey(client)).toBe('env:AIza-other-window');
		expect(changes).toEqual(['restarted']);
	}, SLOW_KILL_TIMEOUT_MS);

	it('does nothing when the dialog for a new key is dismissed', async () => {
		const client = createAgent();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);

		await client.setApiKey();

		expect(await secrets.get(API_KEY_SECRET)).toBeUndefined();
	});

	it('signs in with the picked method, or with an API key', async () => {
		const client = createAgent();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('AIza-via-signin');

		await client.signIn({ kind: 'api-key' });

		expect(await secrets.get(API_KEY_SECRET)).toBe('AIza-via-signin');
		await client.signIn({ kind: 'remove-api-key' });
		expect(await secrets.get(API_KEY_SECRET)).toBeUndefined();
	});

	it('kills the process on dispose', async () => {
		const client = createAgent();
		await client.ensureStarted();
		const pid = (client as unknown as { child: { pid: number } }).child.pid;
		expect(isAlive(pid)).toBe(true);

		client.dispose();

		await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000 });
		await expect(client.ensureStarted()).rejects.toThrow('disposed');
	});
});

describe('readTokenUsage', () => {
	it('prefers the server quota over the standard usage field', () => {
		expect(readTokenUsage({
			usage: { inputTokens: 1, outputTokens: 1 },
			_meta: { quota: { token_count: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100 } } },
		})).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, totalTokens: 115 });
	});

	it('is undefined without usage, and clamps nonsense to zero', () => {
		expect(readTokenUsage({})).toBeUndefined();
		expect(readTokenUsage({ usage: { inputTokens: -4, outputTokens: Number.NaN, totalTokens: 9 } })).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 9 });
	});
});

describe('describeAgent', () => {
	it('names the server, its command and the credentials', () => {
		expect(describeAgent(launchSpecFor(), 'api-key', false))
			.toBe('Google ACP runs Antigravity through "agy_acp_server" using a saved Gemini API key.');
		expect(describeAgent(launchSpecFor(), 'account', true))
			.toBe('Google ACP runs Antigravity through "agy_acp_server" using the account the server is signed in with. Sign-in is required: run "Google ACP: Sign In".');
	});
});

describe('authentication', () => {
	it('authenticates with the API key method when a key is saved', async () => {
		const client = createAgent();
		await secrets.store(API_KEY_SECRET, 'AIza-key');

		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		let reply = '';
		await client.prompt(session.sessionId, [{ type: 'text', text: 'auth' }], { onText: text => { reply += text; } });

		expect(reply).toBe('auth:gemini-api-key');
	});

	it('signs in with Google when no key is saved', async () => {
		const client = createAgent();
		const session = await client.createSession({ cwd: temp, mcpServers: [] });
		let reply = '';
		await client.prompt(session.sessionId, [{ type: 'text', text: 'auth' }], { onText: text => { reply += text; } });

		expect(reply).toBe('auth:oauth-personal');
	});

	it('selects the requested model through the model config option', async () => {
		const client = createAgent();

		const session = await client.createSession({ cwd: temp, mcpServers: [], model: 'other' });

		expect(session.configOptions[0]?.currentValue).toBe('other');
	});
});