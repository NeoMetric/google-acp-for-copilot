/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { askForApiKey, authenticateMethodFor, pickAuthChoice, type AdvertisedAuthMethod, type ApiKeyStore, type AuthChoice } from './auth';
import type { AcpContentBlock } from './convert';
import { assertShellSafe, launchSpecFor, resolveCommand, type LaunchSpec } from './launch';
import { ServerInstaller } from './server';
import { levelOfLine, scopedLog, type Log, type LogLevel } from './logging';
import { findModelOption } from './models';
import { forgetAgent, killOrphanedServers, killStrayAgents, killTree, killTreeSync, pipeLines, recordAgent, trackChild, untrackChild } from './processes';
import { describeTier, formatReset, parseQuotaError, QuotaLimitError, type QuotaLimit } from './quota';
import { isAuthRequiredError, JsonRpcConnection, RpcConnectionClosedError, RpcError } from './rpc';

const ACP_PROTOCOL_VERSION = 1;
/** JSON-RPC code for "invalid params". */
const INVALID_PARAMS_CODE = -32602;

/** Settings that decide which process runs; changing one restarts the agent. */
const LAUNCH_SETTINGS = ['googleAcp.agent.command', 'googleAcp.agent.args'];
/** Signing in with Google waits for the user in a browser. */
const AUTHENTICATE_TIMEOUT_MS = 5 * 60_000;
/** Environment variables the ACP servers read an API key or Vertex AI setup from. */
const API_KEY_VARIABLES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
/** ACP tool kinds of the agent's own tools; tools of an MCP server are reported as `other`. */
const NATIVE_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch']);
/**
 * The built-in tools of the Antigravity server, by the exact names it reports them under. Sent as
 * `_meta.antigravity.disabledTools` so the agent can only use the tools of the chat. `finish` and
 * `ask_question` stay, as the agent needs them to end a turn and to ask the user.
 */
const DISABLED_BUILTIN_TOOLS = ['run_command', 'view_file', 'create_file', 'edit_file', 'list_directory', 'search_directory', 'find_file', 'search_web', 'read_url_content', 'generate_image', 'start_subagent'];
// TEMPORARILY DISABLED to check how the agent behaves without this extra system prompt text. The built-in tools are
// already disabled through `disabledTools`, so the first sentences are redundant; the "read the schema first" sentence
// came from commit 9f9daac (model omitted required arguments), so watch for that problem coming back.
// /** Appended to the agent's system prompt (the server advertises `systemPrompt.append`) so it prefers the tools of the chat. */
// const TOOLS_INSTRUCTION = "Use only the tools of the MCP server named \"vscode\" for reading and changing files, running commands and searching. Do not use your own built-in file, shell, search or web tools. Before you call one of those tools for the first time, read its schema file, then pass every argument the schema lists as required.";

/** Time limits for the short requests; `session/prompt` has none, as a turn can run for long. */
const INITIALIZE_TIMEOUT_MS = 120_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;
const SET_CONFIG_TIMEOUT_MS = 30_000;
const CLOSE_SESSION_TIMEOUT_MS = 10_000;
const SERVER_IDLE_TIMEOUT_MS = 30_000;

/** How long a permission prompt waits for the user before the tool is declined. */
const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** An agent that exits sooner than this after it started counts as failing to start. */
const FAST_EXIT_MS = 10_000;
/** After this many failed starts in a row the agent is not started again until the cool-down passes or a manual restart. */
const MAX_FAST_EXITS = 3;
const FAST_EXIT_COOLDOWN_MS = 2 * 60_000;

export interface AcpMcpHttpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
	readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface AcpConfigOptionChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string | null;
}

export interface AcpConfigOptionGroup {
	readonly group: string;
	readonly options: ReadonlyArray<AcpConfigOptionChoice>;
}

export interface AcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly description?: string | null;
	readonly category?: string | null;
	readonly type: string;
	readonly currentValue?: string | boolean;
	readonly options?: ReadonlyArray<AcpConfigOptionChoice | AcpConfigOptionGroup>;
}

/** The loosely typed content block carried by an agent -> client `session/update`. */
export interface AcpUpdateContent {
	readonly type: string;
	readonly text?: string;
	/** Base64 payload of an image block. */
	readonly data?: string;
	readonly mimeType?: string;
	readonly uri?: string | null;
}

export interface AcpSessionUpdate {
	readonly sessionUpdate: string;
	readonly content?: AcpUpdateContent | null;
	readonly toolCallId?: string;
	readonly title?: string;
	readonly used?: number;
	readonly size?: number;
	readonly entries?: ReadonlyArray<{ readonly content: string; readonly status: string; readonly priority: string }>;
}

export interface AgentSession {
	readonly sessionId: string;
	configOptions: readonly AcpConfigOption[];
}

export interface CreateSessionOptions {
	readonly cwd: string;
	readonly mcpServers: readonly AcpMcpHttpServer[];
	readonly model?: string;
	/** Text added to the end of the agent's own system prompt, which stays in place. */
	readonly systemPromptAppend?: string;
}

export interface PromptHandlers {
	readonly onText: (text: string) => void;
	readonly onThought?: (text: string) => void;
	readonly onUpdate?: (update: AcpSessionUpdate) => void;
	readonly token?: vscode.CancellationToken;
}

/** Token counts of one turn, as reported by the agent. */
export interface AcpTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedReadTokens: number;
	readonly cachedWriteTokens: number;
	readonly totalTokens: number;
	readonly reasoningOutputTokens?: number;
}

export interface PromptResult {
	readonly stopReason: string;
	readonly usage?: AcpTokenUsage;
}

/**
 * Why {@link AgentClient.onDidChange} fired: `restarted` after a deliberate
 * restart (the account may have changed), `exited` after the process died on
 * its own.
 */
export type AgentChange = 'restarted' | 'exited';

/** Thrown when the ACP server program is not on the machine. */
export class AgentNotFoundError extends Error {

	constructor(readonly spec: LaunchSpec, readonly bundled = false) {
		super(bundled ? "The Antigravity ACP server is not downloaded yet. Run \"Google ACP: Set Up\" to download it (about 125 MB, once)." : agentNotFoundMessage(spec));
		this.name = "AgentNotFoundError";
	}
}

function agentNotFoundMessage(spec: LaunchSpec): string {
	return `Could not find "${spec.command}", the Antigravity ACP server. Check googleAcp.agent.command, or clear it to use Google's Antigravity server.`;
}

/** A start that was overtaken by a stop or restart; callers start again instead of failing. */
class StartSupersededError extends Error {

	constructor() {
		super("The Google agent was stopped while it was starting.");
		this.name = "StartSupersededError";
	}
}

export interface EnsureStartedOptions {
	/** Reserved for silent background work, which must never open prompts. */
	readonly silent?: boolean;
}

interface AcpInitializeResponse {
	readonly protocolVersion?: number;
	readonly authMethods?: readonly AdvertisedAuthMethod[];
	readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string };
	readonly agentCapabilities?: Record<string, unknown>;
}

interface AcpNewSessionResponse {
	readonly sessionId: string;
	readonly configOptions?: ReadonlyArray<AcpConfigOption>;
	readonly _meta?: Record<string, unknown>;
}

interface AcpPromptResponse {
	readonly stopReason?: string;
	readonly usage?: Partial<AcpTokenUsage>;
	readonly _meta?: { readonly quota?: { readonly token_count?: Partial<AcpTokenUsage> } } & Record<string, unknown>;
}

interface PermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: string;
}

interface RequestPermissionParams {
	readonly sessionId?: string;
	readonly toolCall?: { readonly toolCallId?: string; readonly title?: string; readonly kind?: string };
	readonly options?: ReadonlyArray<PermissionOption>;
}

interface PermissionChoice extends vscode.MessageItem {
	readonly option: PermissionOption;
}

/**
 * Owns the ACP server process (`agy_acp_server`): starts
 * it, speaks ACP over its stdio, and exposes the operations the language model
 * provider needs. Account credentials stay inside Google's own CLI; the only
 * secret this class handles is an optional API key it passes in the environment.
 */
export class AgentClient implements vscode.Disposable {

	private readonly limitEmitter = new vscode.EventEmitter<QuotaLimit | undefined>();
	/** Fires when a request hit a usage limit, with the limit, and with `undefined` once a request works again. */
	readonly onDidChangeLimit = this.limitEmitter.event;
	private limit: QuotaLimit | undefined;
	/** The plan tier the server reported when it created a session, if it did. */
	private tier: string | undefined;

	private readonly changeEmitter = new vscode.EventEmitter<AgentChange>();
	/** Fires after the process was restarted, exited on its own, or a sign-in flow finished. */
	readonly onDidChange = this.changeEmitter.event;

	private child: cp.ChildProcess | undefined;
	private rpc: JsonRpcConnection | undefined;
	private startedAt = 0;
	private starting: Promise<JsonRpcConnection> | undefined;
	/** Bumped whenever the process is stopped, so a start that was overtaken can notice. */
	private generation = 0;
	private fastExits = 0;
	private lastFailureAt = 0;
	private disposed = false;
	private readonly liveSessions = new Map<string, object>();
	private idleOperations = 0;
	private idleTimer: NodeJS.Timeout | undefined;

	private readonly turnSinks = new Map<string, (update: AcpSessionUpdate) => void>();
	/** Resolvers of the permission prompts that are open, by ACP session. */
	private readonly openPermissions = new Map<string, Set<() => void>>();
	private authMethods: readonly AdvertisedAuthMethod[] = [];
	private signInRequired = false;
	private readonly apiKeyListener: vscode.Disposable;
	private readonly configListener: vscode.Disposable;
	/** The API key the running process was started with, to tell whether a change needs a restart. */
	private spawnedWithKey: string | undefined;
	private keyRestart: Promise<void> | undefined;
	private readonly write: Log;
	private readonly serverInstaller: ServerInstaller;

	constructor(
		private readonly context: vscode.ExtensionContext,
		output: vscode.LogOutputChannel,
		private readonly apiKeys: ApiKeyStore,
	) {
		this.write = scopedLog(output, 'agent');
		this.serverInstaller = new ServerInstaller(path.join(context.globalStorageUri.fsPath, 'server'), this.write);
		// Another window can save or remove the key too.
		this.apiKeyListener = apiKeys.onDidChange(() => void this.applyApiKeyChange());
		this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('googleAcp.authPreference')) {
				void this.applyApiKeyChange();
			} else if (LAUNCH_SETTINGS.some(setting => event.affectsConfiguration(setting))) {
				void this.restart();
			}
		});
	}

	/** The program and arguments the settings select. */
	get launchSpec(): LaunchSpec {
		const config = vscode.workspace.getConfiguration('googleAcp');
		return launchSpecFor({
			command: config.get<string>('agent.command'),
			args: config.get<string[]>('agent.args'),
		});
	}

	/** Whether the `googleAcp.authPreference` setting tells the agent to ignore API keys. */
	private get oauthOnly(): boolean {
		return vscode.workspace.getConfiguration('googleAcp').get<string>('authPreference', 'auto') === 'oauth';
	}

	/** The saved API key the agent should start with, or undefined when the setting prefers the signed-in account. */
	private async effectiveApiKey(): Promise<string | undefined> {
		return this.oauthOnly ? undefined : this.apiKeys.get();
	}

	/** Whether the running process was started with a saved API key. */
	get usesApiKey(): boolean {
		return this.spawnedWithKey !== undefined;
	}

	/** Whether the agent refused a request with "authentication required". */
	get requiresSignIn(): boolean {
		return this.signInRequired;
	}

	/** Sign-in methods advertised by the agent during `initialize`. */
	get availableAuthMethods(): readonly AdvertisedAuthMethod[] {
		return this.authMethods;
	}

	/** Whether the agent runs Google's own server, which the extension downloads, rather than a program the user configured. */
	get usesDownloadedServer(): boolean {
		const command = vscode.workspace.getConfiguration('googleAcp').get<string>('agent.command')?.trim();
		return !command;
	}

	/** Whether the ACP server program can be found, so starting the agent can work. */
	async isInstalled(): Promise<boolean> {
		if (this.usesDownloadedServer) {
			return (await this.serverInstaller.find()) !== undefined;
		}
		return resolveCommand(this.launchSpec.command, this.baseEnv()) !== undefined;
	}

	/** Downloads Google's Antigravity server if it is needed and missing, then starts the agent; the explicit, user-initiated path. */
	async setUp(): Promise<void> {
		if (this.usesDownloadedServer && !await this.isInstalled()) {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "Google ACP: downloading Google's Antigravity ACP server (first run only)…" },
				progress => {
					let reported = 0;
					return this.serverInstaller.install((received, total) => {
						if (total) {
							const percent = Math.floor(received / total * 100);
							progress.report({ increment: percent - reported, message: `${percent}%` });
							reported = percent;
						}
					});
				},
			);
		}
		await this.ensureStarted();
	}

	/** Starts the agent if needed and returns the live connection. */
	async ensureStarted(options: EnsureStartedOptions = {}): Promise<JsonRpcConnection> {
		const release = this.holdServer();
		try {
			// A restart (a changed API key, a sign-in) can overtake a start in flight; the start
			// then begins again against the new state instead of failing the caller.
			for (let attempt = 0; ; attempt++) {
				try {
					return await this.startOnce(options);
				} catch (error) {
					if (!(error instanceof StartSupersededError) || attempt >= 2 || this.disposed) {
						throw error;
					}
				}
			}
		} finally {
			release();
		}
	}

	private async startOnce(_options: EnsureStartedOptions): Promise<JsonRpcConnection> {
		if (this.disposed) {
			throw new Error("The Google agent has been disposed.");
		}
		if (this.starting) {
			return this.starting;
		}
		if (this.rpc) {
			return this.rpc;
		}
		if (this.fastExits >= MAX_FAST_EXITS && Date.now() - this.lastFailureAt > FAST_EXIT_COOLDOWN_MS) {
			this.log('The cool-down after repeated start failures has passed; trying to start the agent again.');
			this.fastExits = 0;
		}
		if (this.fastExits >= MAX_FAST_EXITS) {
			throw new Error("The Google agent keeps stopping right after it starts. See the \"Google ACP\" output channel, then run \"Google ACP: Restart Agent\".");
		}

		const starting = this.start();
		this.starting = starting;
		const clear = () => {
			if (this.starting === starting) {
				this.starting = undefined;
			}
		};
		starting.then(clear, clear);
		return starting;
	}

	async createSession(options: CreateSessionOptions): Promise<AgentSession> {
		const release = this.holdServer();
		try {
			const rpc = await this.ensureStarted();

			const { params, withMeta } = this.sessionParams(options);

			try {
				let response: AcpNewSessionResponse;
				try {
					response = await rpc.request<AcpNewSessionResponse>('session/new', params, { timeoutMs: NEW_SESSION_TIMEOUT_MS });
				} catch (error) {
					// Without the options the agent would run with its own tools and no Copilot guidance, so the session is not created.
					if (!withMeta || !(error instanceof RpcError) || error.code !== INVALID_PARAMS_CODE) {
						throw error;
					}
					throw new Error(`The Google agent refused the session options that turn off its built-in tools and carry the Copilot guidance (${describeError(error)}), so no session was started. Update the Antigravity ACP server.`, { cause: error });
				}
				this.log(`Created ACP session ${response.sessionId} with ${response.configOptions?.length ?? 0} config option(s)`);
				this.noteSessionMeta(response._meta);
				const session: AgentSession = { sessionId: response.sessionId, configOptions: response.configOptions ?? [] };
				await this.applyModel(session, options.model);
				if (this.rpc !== rpc) {
					throw new RpcConnectionClosedError("The Google agent was stopped while opening a session.");
				}
				this.liveSessions.set(session.sessionId, {});
				return session;
			} catch (error) {
				this.captureAuthState(error);
				throw error;
			}
		} finally {
			release();
		}
	}

	/**
	 * Opens the agent's stored conversation `sessionId` again, as it was: the
	 * agent rebuilds the exact messages from its transcript, so the prompt cache
	 * can serve them. The session keeps its id.
	 */
	async resumeSession(sessionId: string, options: CreateSessionOptions): Promise<AgentSession> {
		const release = this.holdServer();
		try {
			const rpc = await this.ensureStarted();
			try {
				const response = await rpc.request<Partial<AcpNewSessionResponse>>('session/resume', { sessionId, ...this.sessionParams(options).params }, { timeoutMs: NEW_SESSION_TIMEOUT_MS });
				const resumedId = response?.sessionId ?? sessionId;
				this.noteSessionMeta(response?._meta, 'session/resume response');
				this.log(`Resumed ACP session ${resumedId} with ${response?.configOptions?.length ?? 0} config option(s)`);
				const session: AgentSession = { sessionId: resumedId, configOptions: response?.configOptions ?? [] };
				await this.applyModel(session, options.model);
				if (this.rpc !== rpc) {
					throw new RpcConnectionClosedError("The Google agent was stopped while resuming a session.");
				}
				this.liveSessions.set(session.sessionId, {});
				return session;
			} catch (error) {
				this.captureAuthState(error);
				throw error;
			}
		} finally {
			release();
		}
	}

	/**
	 * The parameters a session is opened with. The append is part of them so a
	 * resumed session keeps the prompt it was opened with, and the cache with it.
	 */
	private sessionParams(options: CreateSessionOptions) {
		const base = { cwd: options.cwd, mcpServers: options.mcpServers };
		const withoutOwnTools = !this.useBuiltInTools;
		// TOOLS_INSTRUCTION is temporarily disabled (see the note at its definition).
		const append = [/* withoutOwnTools ? TOOLS_INSTRUCTION : undefined, */ options.systemPromptAppend].filter(part => part).join('\n\n');
		const antigravity = {
			...(withoutOwnTools ? { disabledTools: DISABLED_BUILTIN_TOOLS } : {}),
			...(append ? { systemPrompt: { append } } : {}),
		};
		const withMeta = Object.keys(antigravity).length > 0;
		return { params: withMeta ? { ...base, _meta: { antigravity } } : base, withMeta };
	}

	/** ACP has no model field on `session/new`; the model is an ordinary config option. */
	private async applyModel(session: AgentSession, model: string | undefined): Promise<void> {
		const modelOption = model ? findModelOption(session.configOptions) : undefined;
		if (model && modelOption && modelOption.currentValue !== model) {
			session.configOptions = await this.setConfigOption(session.sessionId, modelOption.id, model) ?? session.configOptions;
		}
	}

	/** Releases an agent-side session; best effort, as the method is an ACP extension. */
	async closeSession(sessionId: string): Promise<void> {
		const release = this.holdServer();
		const generation = this.generation;
		const session = this.liveSessions.get(sessionId);
		try {
			this.cancelOpenPermissions(sessionId);
			const rpc = this.rpc;
			if (!rpc) {
				return;
			}
			try {
				await rpc.request('session/close', { sessionId }, { timeoutMs: CLOSE_SESSION_TIMEOUT_MS });
			} catch {
				// The session is gone either way: an agent that does not know the method
				// drops it when the process exits.
			}
		} finally {
			if (generation === this.generation && this.liveSessions.get(sessionId) === session) {
				this.liveSessions.delete(sessionId);
			}
			release();
		}
	}

	/** Applies a session config option, used to switch the model or the effort of an existing session. */
	async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<readonly AcpConfigOption[] | undefined> {
		const rpc = this.requireConnection();
		const response = await rpc.request<{ configOptions?: readonly AcpConfigOption[] }>('session/set_config_option', { sessionId, configId, value }, { timeoutMs: SET_CONFIG_TIMEOUT_MS });
		this.log(`Set session ${sessionId} option ${configId}=${String(value)}`);
		return response?.configOptions;
	}

	/** Asks the agent to stop the current turn of a session. */
	cancel(sessionId: string): void {
		// ACP requires a cancelled turn to answer its open permission requests.
		this.cancelOpenPermissions(sessionId);
		this.rpc?.notify('session/cancel', { sessionId });
	}

	/** Runs one ACP turn and streams its agent text chunks to `handlers.onText`. */
	async prompt(sessionId: string, blocks: readonly AcpContentBlock[], handlers: PromptHandlers): Promise<PromptResult> {
		const rpc = this.requireConnection();

		const sink = (update: AcpSessionUpdate) => {
			if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
				const text = update.content?.type === 'text' ? update.content.text : undefined;
				if (text) {
					if (update.sessionUpdate === 'agent_message_chunk') {
						handlers.onText(text);
					} else {
						handlers.onThought?.(text);
					}
				}
			}
			handlers.onUpdate?.(update);
		};
		this.turnSinks.set(sessionId, sink);

		const cancellation = handlers.token?.onCancellationRequested(() => {
			this.log(`Cancelling ACP session ${sessionId}`);
			this.cancel(sessionId);
		});

		try {
			const response = await rpc.request<AcpPromptResponse>('session/prompt', { sessionId, prompt: blocks });
			this.logMeta('prompt response', response._meta);
			const usage = readTokenUsage(response);
			if (!usage) {
				// Shown at info level: without a per-turn breakdown there are no cache statistics.
				this.log(`The prompt response carried no token usage; fields: ${JSON.stringify(response).slice(0, 1500)}`);
			}
			this.setLimit(undefined);
			return { stopReason: response.stopReason ?? 'end_turn', usage };
		} catch (error) {
			this.captureAuthState(error);
			const limit = parseQuotaError(error);
			if (limit) {
				this.setLimit(limit);
				throw new QuotaLimitError(limit, Date.now(), { cause: error });
			}
			throw error;
		} finally {
			cancellation?.dispose();
			if (this.turnSinks.get(sessionId) === sink) {
				this.turnSinks.delete(sessionId);
			}
		}
	}

	/**
	 * Signs in: asks how (a Google account in the browser, or a Gemini API key)
	 * unless `choice` says, then runs that flow.
	 */
	async signIn(choice?: AuthChoice): Promise<void> {
		const picked = choice ?? await pickAuthChoice(await this.apiKeys.get() !== undefined);
		if (!picked) {
			return;
		}

		switch (picked.kind) {
			case 'api-key':
				return this.setApiKey();
			case 'remove-api-key':
				return this.removeApiKey();
			case 'google-login':
				return this.signInWithGoogle();
		}
	}

	/** Asks for a Gemini API key, saves it in secret storage and restarts the agent to use it. */
	async setApiKey(): Promise<void> {
		const key = await askForApiKey();
		if (!key) {
			return;
		}
		await this.apiKeys.set(key);
		await this.applyApiKeyChange();
		this.log('Saved a Gemini API key.');
		void vscode.window.showInformationMessage("Google ACP: the API key was saved and the agent now uses it.");
	}

	/** Deletes the saved API key and restarts the agent so it falls back to its signed-in account. */
	async removeApiKey(): Promise<void> {
		if (await this.apiKeys.get() === undefined) {
			void vscode.window.showInformationMessage("Google ACP: no API key is saved.");
			return;
		}
		await this.apiKeys.clear();
		await this.applyApiKeyChange();
		this.log('Removed the saved Gemini API key.');
		void vscode.window.showInformationMessage("Google ACP: the saved API key was removed.");
	}

	/** Restarts the agent when the saved key is not the one it was started with. */
	private applyApiKeyChange(): Promise<void> {
		this.keyRestart ??= (async () => {
			const current = await this.effectiveApiKey();
			if (current === this.spawnedWithKey || this.disposed) {
				return;
			}
			this.spawnedWithKey = current;
			await this.restart();
		})().finally(() => {
			this.keyRestart = undefined;
		});
		return this.keyRestart;
	}

	/**
	 * Starts the agent, which signs in with Google in the browser the first time
	 * (the server keeps the tokens afterwards). A saved API key would win over
	 * the account, so the user is asked about it first.
	 */
	private async signInWithGoogle(): Promise<void> {
		if (await this.effectiveApiKey() !== undefined) {
			const choice = await vscode.window.showWarningMessage(
				"A Gemini API key is saved for Google ACP, and the agent uses it instead of a Google account. Set googleAcp.authPreference to \"oauth\" to keep the key but use the account.",
				"Remove Key and Sign In",
				"Keep Key and Sign In",
			);
			if (!choice) {
				return;
			}
			if (choice === "Remove Key and Sign In") {
				await this.apiKeys.clear();
			}
		}

		await this.restart();
		await this.setUp();
		void vscode.window.showInformationMessage(this.signInRequired
			? "Google ACP: sign-in did not complete. Try again, or check the Google ACP output channel."
			: "Google ACP: signed in.");
	}
	/** Kills the agent process, drops every session and notifies listeners. */
	async restart(): Promise<void> {
		this.log('Restarting the Google agent');
		await this.stopProcess();
		this.fastExits = 0;
		this.signInRequired = false;
		this.authMethods = [];
		this.changeEmitter.fire('restarted');
	}

	/** Whether an agent process is running or on its way up. */
	get isRunning(): boolean {
		return this.rpc !== undefined || this.starting !== undefined;
	}

	/**
	 * Stops the process once nothing needs it. Unlike {@link restart} it keeps the
	 * sign-in state and tells no listener, because nothing was lost: the next
	 * request starts the agent again.
	 */
	async stopWhenIdle(): Promise<void> {
		if (!this.rpc || this.starting) {
			return;
		}
		this.log('Nothing has used the Google agent for a while; stopping it. The next request starts it again.');
		await this.stopProcess();
		// `handleExit` ignores a process that was detached first, so the record is dropped here.
		forgetAgent(this.agentRegistry);
	}

	/** Tells which server runs and which credentials it was given. */
	showAccount(): void {
		const credentials = this.spawnedWithKey !== undefined ? 'api-key' : 'account';
		this.log('Showed the account status.', 'debug');
		if (this.signInRequired) {
			this.log('Sign-in is required. Run "Google ACP: Sign In", then "Google ACP: Restart Agent".', 'warn');
		}
		void vscode.window.showInformationMessage(describeAgent(this.launchSpec, credentials, this.signInRequired, this.tier, this.limit));
	}

	/** The usage limit the last request hit, until a request works again or its reset time passes. */
	get currentLimit(): QuotaLimit | undefined {
		return this.limit?.resetAt !== undefined && this.limit.resetAt <= Date.now() ? undefined : this.limit;
	}

	private setLimit(limit: QuotaLimit | undefined): void {
		if (limit === undefined && this.limit === undefined) {
			return;
		}
		this.limit = limit;
		if (limit) {
			this.log(`Usage limit reached: ${limit.message}${limit.resetAt !== undefined ? ` (resets ${formatReset(limit.resetAt)})` : ''}`, 'warn');
		}
		this.limitEmitter.fire(limit);
	}

	private noteSessionMeta(meta: Record<string, unknown> | undefined, where = 'session/new response'): void {
		this.logMeta(where, meta);
		const antigravity = meta?.antigravity;
		const tier = antigravity && typeof antigravity === 'object' ? describeTier((antigravity as Record<string, unknown>).tier) : undefined;
		if (tier && tier !== this.tier) {
			this.tier = tier;
			this.log(`The server reports the plan tier "${tier}".`);
		}
	}

	/** Logs what the server sends under `_meta`, to find out which usage details it offers. */
	private logMeta(where: string, meta: unknown): void {
		if (meta !== undefined && meta !== null) {
			this.log(`${where} _meta: ${JSON.stringify(meta).slice(0, 1500)}`, 'debug');
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.apiKeyListener.dispose();
		this.configListener.dispose();
		this.changeEmitter.dispose();
		this.limitEmitter.dispose();

		// Shutdown cannot wait for the event loop, so the process is killed synchronously.
		const { child } = this.detachProcess(new RpcConnectionClosedError("The Google agent was stopped."));
		if (child?.pid) {
			killTreeSync(child.pid);
		}
		forgetAgent(this.agentRegistry);
	}

	/** Whether the agent may use its own tools next to the VS Code tools of the chat. */
	private get useBuiltInTools(): boolean {
		return vscode.workspace.getConfiguration('googleAcp').get<boolean>('useAgentBuiltInTools', false);
	}

	private get agentRegistry(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'agents');
	}

	/** The environment the agent and the sign-in terminal run in, without any API key variables when the account is preferred. */
	private baseEnv(): NodeJS.ProcessEnv {
		const env = { ...process.env };
		if (this.oauthOnly) {
			for (const name of API_KEY_VARIABLES) {
				delete env[name];
			}
		}
		return env;
	}

	private async start(): Promise<JsonRpcConnection> {
		const generation = this.generation;
		const spec = this.launchSpec;
		const env = this.baseEnv();
		let resolved: { file: string; viaShell: boolean };
		let args: readonly string[] = spec.args;
		if (this.usesDownloadedServer) {
			const installed = await this.serverInstaller.find();
			if (!installed) {
				throw new AgentNotFoundError(spec, true);
			}
			resolved = { file: installed.file, viaShell: false };
			args = installed.args;
		} else {
			const found = resolveCommand(spec.command, env);
			if (!found) {
				throw new AgentNotFoundError(spec);
			}
			resolved = found;
		}
		const cwd = workspaceCwd();
		const apiKey = await this.effectiveApiKey();
		if (this.disposed || generation !== this.generation) {
			throw new StartSupersededError();
		}
		this.spawnedWithKey = apiKey;
		const strays = killStrayAgents(this.agentRegistry);
		if (this.usesDownloadedServer) {
			strays.push(...await killOrphanedServers(resolved.file));
			if (this.disposed || generation !== this.generation) {
				throw new StartSupersededError();
			}
		}
		if (strays.length > 0) {
			this.log(`Stopped ${strays.length} leftover agent process(es) from closed windows: ${strays.join(', ')}`, 'warn');
		}

		this.log(`Starting the agent: ${resolved.file} ${args.join(' ')} in ${cwd}${apiKey ? ' with the saved API key' : this.oauthOnly ? ' using the signed-in account only' : ''}`.trim());

		const spawnEnv = {
			...env,
			// A saved key wins over one in the environment and over a signed-in account.
			...(apiKey ? { GEMINI_API_KEY: apiKey } : {}),
			GOOGLE_ACP_LOGS: path.join(this.context.globalStorageUri.fsPath, 'logs'),
		};
		const options: cp.SpawnOptions = {
			cwd,
			env: spawnEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			detached: process.platform !== 'win32',
		};
		let child: cp.ChildProcess;
		if (resolved.viaShell) {
			assertShellSafe(args);
			child = cp.spawn(`"${resolved.file}"`, [...args], { ...options, shell: true });
		} else {
			child = cp.spawn(resolved.file, [...args], options);
		}

		if (!child.pid || !child.stdin || !child.stdout) {
			throw new Error("Failed to start the Google agent process.");
		}

		trackChild(child.pid);
		recordAgent(this.agentRegistry, child.pid);
		this.child = child;
		this.startedAt = Date.now();
		child.on('error', error => this.log(`Agent process error: ${error.message}`, 'error'));
		child.on('exit', (code, signal) => this.handleExit(child, code, signal));
		if (child.stderr) {
			pipeLines(child.stderr, line => this.log(line, levelOfLine(line)));
		}

		const rpc = new JsonRpcConnection(child.stdout, child.stdin, (message, level) => this.log(message, level));
		this.rpc = rpc;
		rpc.onNotification((method, params) => this.handleNotification(method, params));
		rpc.onRequest('session/request_permission', params => this.handlePermissionRequest(params));

		try {
			const response = await rpc.request<AcpInitializeResponse>('initialize', {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: {
					name: 'google-acp-for-copilot',
					title: 'Google ACP for Copilot',
					version: this.context.extension.packageJSON.version as string,
				},
			}, { timeoutMs: INITIALIZE_TIMEOUT_MS });

			this.authMethods = response.authMethods ?? [];
			this.log(`Initialized ACP protocol ${response.protocolVersion ?? ACP_PROTOCOL_VERSION} with ${response.agentInfo?.title ?? response.agentInfo?.name ?? 'Google agent'} ${response.agentInfo?.version ?? ''}`.trim());
			this.log(`Auth methods: ${this.authMethods.map(method => method.id ?? method.name ?? 'unknown').join(', ') || 'none'}`);
			await this.authenticate(rpc, apiKey !== undefined);
			return rpc;
		} catch (error) {
			this.captureAuthState(error);
			this.log(`Failed to initialize the agent: ${describeError(error)}`, 'error');
			// Only this start's own process: a restart may already have replaced it. When the
			// process died, its output usually closes before the exit event arrives, so a
			// failed start is counted here and not in `handleExit`, which never sees it.
			if (this.child === child) {
				if (!isAuthRequiredError(error)) {
					this.fastExits++;
					this.lastFailureAt = Date.now();
				}
				await this.stopProcess();
			}
			throw error;
		}
	}

	/** Both servers refuse sessions until a sign-in method was chosen, unless their own settings file names one. */
	private async authenticate(rpc: JsonRpcConnection, hasApiKey: boolean): Promise<void> {
		const methodId = authenticateMethodFor(this.authMethods, hasApiKey);
		if (!methodId) {
			return;
		}
		try {
			await rpc.request('authenticate', { methodId }, { timeoutMs: AUTHENTICATE_TIMEOUT_MS });
			this.log(`Authenticated with ${methodId}.`);
		} catch (error) {
			this.signInRequired = true;
			this.log(`Authentication with ${methodId} failed: ${describeError(error)}`, 'warn');
		}
	}
	private requireConnection(): JsonRpcConnection {
		if (!this.rpc) {
			throw new RpcConnectionClosedError("The Google agent is not running.");
		}
		return this.rpc;
	}

	private handleExit(child: cp.ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.child !== child) {
			return;
		}
		if (child.pid) {
			untrackChild(child.pid);
		}
		this.detachProcess(new RpcConnectionClosedError("The Google agent exited."));
		this.log(`Agent exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`, code === 0 || code === null ? 'info' : 'warn');

		this.fastExits = Date.now() - this.startedAt < FAST_EXIT_MS ? this.fastExits + 1 : 0;
		this.lastFailureAt = Date.now();
		forgetAgent(this.agentRegistry);
		if (!this.disposed) {
			this.changeEmitter.fire('exited');
		}
	}

	private holdServer(): () => void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.idleOperations++;
		return () => {
			this.idleOperations--;
			if (this.disposed || this.idleOperations || this.liveSessions.size || !this.child) {
				return;
			}
			this.idleTimer = setTimeout(() => {
				this.idleTimer = undefined;
				if (this.idleOperations || this.liveSessions.size || !this.child) {
					return;
				}
				this.log('Stopping the idle Google agent.');
				forgetAgent(this.agentRegistry);
				void this.stopProcess();
			}, SERVER_IDLE_TIMEOUT_MS);
			this.idleTimer.unref();
		};
	}

	/** Forgets the process and connection and fails everything that was waiting on them. */
	private detachProcess(reason: Error): { child: cp.ChildProcess | undefined; rpc: JsonRpcConnection | undefined } {
		const { child, rpc } = this;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.liveSessions.clear();
		this.child = undefined;
		this.rpc = undefined;
		this.starting = undefined;
		this.generation++;
		this.turnSinks.clear();
		for (const sessionId of [...this.openPermissions.keys()]) {
			this.cancelOpenPermissions(sessionId);
		}
		rpc?.dispose(reason);
		return { child, rpc };
	}

	private async stopProcess(): Promise<void> {
		const { child } = this.detachProcess(new RpcConnectionClosedError("The Google agent was stopped."));
		if (child?.pid) {
			await killTree(child.pid);
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === 'session/update') {
			const notification = params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
			const update = notification?.update;
			if (!notification?.sessionId || !update) {
				return;
			}
			// Tool titles and plan entries can quote commands and file names, so they are debug-level.
			if (update.sessionUpdate === 'tool_call') {
				this.log(`tool_call ${update.toolCallId ?? ''}: ${update.title ?? ''}`.trim(), 'debug');
				this.log(`tool_call raw: ${JSON.stringify(update)}`, 'debug');
			} else if (update.sessionUpdate === 'tool_call_update') {
				this.log(`tool_call_update raw: ${JSON.stringify(update)}`, 'debug');
			} else if (update.sessionUpdate === 'plan') {
				this.log(`plan: ${update.entries?.map(entry => `${entry.status}:${entry.content}`).join(' | ') ?? ''}`, 'debug');
			} else if (update.sessionUpdate === 'usage_update') {
				this.log(`usage: ${update.used ?? '?'}/${update.size ?? '?'} tokens`, 'debug');
			}
			this.turnSinks.get(notification.sessionId)?.(update);
			return;
		}

		this.log(`Unhandled agent notification: ${method}`, 'warn');
	}

	private async handlePermissionRequest(params: unknown): Promise<unknown> {
		const request = (params ?? {}) as RequestPermissionParams;
		const options = request.options ?? [];
		const title = request.toolCall?.title ?? request.toolCall?.toolCallId ?? "a tool";
		const offered = options.map(option => `${option.name} (${option.kind})`).join(', ') || "none";

		this.log(`Permission requested for "${title}"; options: ${offered}`, 'debug');

		if (!this.useBuiltInTools && NATIVE_TOOL_KINDS.has(request.toolCall?.kind ?? '')) {
			const reject = options.find(option => option.kind === 'reject_once') ?? options.find(option => option.kind.startsWith('reject'));
			this.log(`Declining the agent's own tool "${title}"; tools run through VS Code.`, 'warn');
			return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
		}

		const mode = vscode.workspace.getConfiguration('googleAcp').get<string>('permissionMode', 'auto');
		if (mode === 'auto') {
			const choice = options.find(option => option.kind === 'allow_once')
				?? options.find(option => option.kind === 'allow_always')
				?? options.find(option => option.kind.startsWith('allow'));
			if (choice) {
				this.log(`Auto-approving a permission request with ${choice.optionId}`);
				return { outcome: { outcome: 'selected', optionId: choice.optionId } };
			}
			this.log('No allow option was offered for a permission request; declining', 'warn');
			return { outcome: { outcome: 'cancelled' } };
		}

		const choices: PermissionChoice[] = options.map(option => ({ title: option.name, option }));
		const picked = await this.askPermission(request.sessionId, `Google ACP wants to run: ${title}. Offered options: ${offered}.`, choices);
		if (!picked) {
			this.log('A permission request was not granted; declining', 'warn');
			return { outcome: { outcome: 'cancelled' } };
		}
		this.log(`User chose ${picked.option.optionId} for a permission request`);
		return { outcome: { outcome: 'selected', optionId: picked.option.optionId } };
	}

	/**
	 * Shows the permission prompt. Resolves with `undefined` when the user
	 * dismisses it, when the turn is cancelled, or when nobody answers in time.
	 */
	private askPermission(sessionId: string | undefined, message: string, choices: readonly PermissionChoice[]): Promise<PermissionChoice | undefined> {
		return new Promise<PermissionChoice | undefined>(resolve => {
			let release = () => { };
			const settle = (choice: PermissionChoice | undefined) => {
				clearTimeout(timer);
				release();
				resolve(choice);
			};

			const timer = setTimeout(() => {
				this.log('A permission prompt timed out; declining', 'warn');
				settle(undefined);
			}, PERMISSION_TIMEOUT_MS);

			if (sessionId) {
				const waiting = this.openPermissions.get(sessionId) ?? new Set<() => void>();
				const cancel = () => settle(undefined);
				waiting.add(cancel);
				this.openPermissions.set(sessionId, waiting);
				release = () => {
					waiting.delete(cancel);
					if (waiting.size === 0 && this.openPermissions.get(sessionId) === waiting) {
						this.openPermissions.delete(sessionId);
					}
				};
			}

			void vscode.window.showWarningMessage(message, ...choices).then(settle, () => settle(undefined));
		});
	}

	private cancelOpenPermissions(sessionId: string): void {
		for (const cancel of [...(this.openPermissions.get(sessionId) ?? [])]) {
			cancel();
		}
	}

	private captureAuthState(error: unknown): void {
		if (isAuthRequiredError(error)) {
			this.signInRequired = true;
			this.log('The Google agent requires sign-in. Run "Google ACP: Sign In" and then "Google ACP: Restart Agent".', 'warn');
		}
	}

	private log(message: string, level: LogLevel = 'info'): void {
		this.write(message, level);
	}
}

/** The folder ACP sessions are rooted in. */
export function workspaceCwd(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? folder.uri.fsPath : os.homedir();
}

/** A one-line account of what the agent runs and which credentials it was given. */
export function describeAgent(spec: LaunchSpec, credentials: 'api-key' | 'account', signInRequired: boolean, tier?: string, limit?: QuotaLimit): string {
	const using = credentials === 'api-key' ? "a saved Gemini API key" : "the account the server is signed in with";
	const plan = tier ? ` Plan: ${tier}.` : '';
	const base = `Google ACP runs Antigravity through "${spec.command}${spec.args.length > 0 ? ' ' + spec.args.join(' ') : ''}" using ${using}.${plan}`;
	const limited = limit ? `${base} Usage limit reached${limit.resetAt !== undefined ? `, resets ${formatReset(limit.resetAt)}` : ''}.` : base;
	return signInRequired ? `${limited} Sign-in is required: run "Google ACP: Sign In".` : limited;
}
function describeError(error: unknown): string {
	if (error instanceof RpcError) {
		return `${error.message} (code ${error.code})`;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the token usage of a finished turn. `_meta.quota.token_count` is the
 * server's own per-turn breakdown; the `usage` field is the standard place a
 * wider range of agents report it.
 */
export function readTokenUsage(response: AcpPromptResponse): AcpTokenUsage | undefined {
	const quota = response._meta?.quota?.token_count;
	const usage = quota ?? response.usage;
	if (!usage) {
		return undefined;
	}

	const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
	const inputTokens = count(usage.inputTokens);
	const outputTokens = count(usage.outputTokens);
	// The quota breakdown names cache reads `cachedInputTokens`; `usage` uses `cachedReadTokens`.
	const cachedReadTokens = count((usage as { cachedInputTokens?: number }).cachedInputTokens ?? usage.cachedReadTokens);
	const cachedWriteTokens = count(usage.cachedWriteTokens);

	return {
		inputTokens,
		outputTokens,
		cachedReadTokens,
		cachedWriteTokens,
		totalTokens: count(usage.totalTokens) || inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
		reasoningOutputTokens: typeof usage.reasoningOutputTokens === 'number' ? usage.reasoningOutputTokens : undefined,
	};
}
