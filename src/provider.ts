/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { type AcpSessionUpdate, AgentNotFoundError, type AgentChange, type AgentClient, type AgentSession, type PromptResult, workspaceCwd } from './agent';
import { type McpBridge, type McpServerEndpoint, type McpToolResult } from './bridge';
import { diverged, fingerprint, lastUserMessageIndex, textOf, toAcpContentBlocks, toTranscriptBlock, type AcpContentBlock } from './convert';
import { scopedLog, type Log, type LogLevel } from './logging';
import { acpModelValue, effortLevelsOf, effortOf, findEffortOption, findModelOption, flattenChoices, toModelVariants } from './models';
import { isAuthRequiredError, RpcConnectionClosedError } from './rpc';

export const VENDOR = 'google-acp';

const CHARS_PER_TOKEN = 4;

/** Per-process nonce, so call ids from an earlier run in a chat's history never match a new call. */
const TOOL_CALL_ID_PREFIX = `google-acp-${randomBytes(4).toString('hex')}-`;

/** Chat sessions kept alive at once; the least recently used idle one is closed beyond this. */
const MAX_CHAT_SESSIONS = 8;

/**
 * How long to collect tool calls before handing a turn back to Copilot, so
 * calls the agent issued in parallel travel in the same response.
 */
const PARALLEL_TOOL_WINDOW_MS = 250;
/** How long to wait for an abandoned turn to end before moving on. */
const ABANDONED_TURN_WAIT_MS = 5_000;

/** One tool call handed to Copilot, settled when its result comes back. */
interface PendingToolCall {
	readonly resolve: (content: ReadonlyArray<unknown>, isError: boolean) => void;
	readonly reject: (error: Error) => void;
}

/**
 * One ACP turn. A turn can outlive a single provider request: when the agent
 * calls a tool, the response ends so Copilot runs the tool, and the next
 * request carrying the tool result continues the same turn.
 */
interface ActiveTurn {
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	prompt: Promise<PromptResult>;
	result?: PromptResult;
	error?: unknown;
	finished: boolean;
	/** False once the current response returned; late output has nowhere to go. */
	streaming: boolean;
	readonly pending: Map<string, PendingToolCall>;
	waiters: Array<() => void>;
	toolCalls: number;
	characters: number;
	/** Token counts of the last model call, as reported by the agent. */
	contextUsed?: number;
	contextSize?: number;
	/** Completion tokens already reported to Copilot. */
	reportedTokens: number;
	startedAt: number;
}

interface ChatSession {
	readonly acp: AgentSession;
	readonly endpoint: McpServerEndpoint;
	readonly history: string[];
	model: string;
	effort?: string;
	turn?: ActiveTurn;
}

const MODELS_KEY = 'googleAcp.models';
const MODEL_RETRY_BASE_MS = 5_000;
const MODEL_RETRY_MAX_MS = 2 * 60_000;
const MODEL_RETRY_LIMIT = 6;

/**
 * Publishes the models of the local Google agent to Copilot Chat and drives
 * one ACP session per chat.
 */
export class GoogleAcpProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable {

	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	private readonly turnEmitter = new vscode.EventEmitter<void>();
	/** Fires after a chat turn ended successfully, which spends plan limits. */
	readonly onDidFinishTurn = this.turnEmitter.event;

	private readonly sessions = new Map<string, ChatSession>();
	private readonly agentListener: vscode.Disposable;
	private readonly write: Log;
	private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private toolCallSeq = 0;
	private warmSession: AgentSession | undefined;
	private warmSessionCreation: Promise<AgentSession> | undefined;
	private signInWarningShown = false;
	private disposed = false;
	private retryTimer: NodeJS.Timeout | undefined;
	private retryAttempt = 0;
	private refreshing = false;

	constructor(
		private readonly agent: AgentClient,
		private readonly bridge: McpBridge,
		private readonly output: vscode.LogOutputChannel,
		private readonly state?: vscode.Memento,
	) {
		this.write = scopedLog(output, 'provider');
		this.agentListener = this.agent.onDidChange(change => this.handleAgentChange(change));
	}

	async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		if (this.cachedModels) {
			return this.cachedModels;
		}

		// Models saved by an earlier run or another window show up at once; the agent
		// confirms them in the background, so a slow or failed start cannot empty the picker.
		const stored = this.state?.get<vscode.LanguageModelChatInformation[]>(MODELS_KEY);
		if (stored && stored.length > 0) {
			this.cachedModels = stored;
			void this.refreshModels();
			return stored;
		}

		return this.lookupModels(options);
	}

	private async lookupModels(options: { readonly silent?: boolean }): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			await this.agent.ensureStarted({ silent: options.silent });
			const warm = await this.ensureWarmSession();
			// A logged-out agent still lists its models; chatting is what fails. Say so up front.
			if (this.agent.requiresSignIn && !options.silent) {
				this.promptSignIn();
			}

			const modelOption = findModelOption(warm.configOptions);
			if (!modelOption) {
				this.log('The agent did not report a model config option; no models can be offered.', 'warn');
				return [];
			}

			const choices = flattenChoices(modelOption.options ?? []);
			const effortLevels = effortLevelsOf(warm.configOptions);
			const models = toModelVariants(choices, effortLevels);
			this.cachedModels = models;
			this.retryAttempt = 0;
			void this.state?.update(MODELS_KEY, models);
			this.log(`Offering ${choices.length} Gemini model(s) for chat and ${choices.length} for the Copilot agent: ${choices.map(choice => choice.value).join(', ')}`);
			this.log(`Thinking effort levels reported by the agent: ${effortLevels.join(', ') || 'none'}`);
			return models;
		} catch (error) {
			if (error instanceof AgentNotFoundError) {
				this.log(error.message, 'warn');
				return [];
			}
			this.log(`Could not list Gemini models: ${describe(error)}`, 'error');
			if (this.isSignInRequired(error)) {
				if (!options.silent) {
					this.promptSignIn();
				}
			} else {
				this.scheduleModelRetry();
				if (!options.silent) {
					void vscode.window.showWarningMessage(
						`Google ACP could not reach its agent: ${describe(error)} See the "Google ACP" output channel for details.`
					);
				}
			}
			return [];
		}
	}

	/** Looks the models up through the agent and tells the workbench when they differ from the cached ones. */
	private async refreshModels(): Promise<void> {
		if (this.refreshing || this.disposed) {
			return;
		}
		this.refreshing = true;
		try {
			const previous = JSON.stringify(this.cachedModels);
			const fresh = await this.lookupModels({ silent: true });
			if (fresh.length === 0) {
				// The lookup failed or found nothing; keep what was shown.
			} else if (JSON.stringify(fresh) !== previous && !this.disposed) {
				this.changeEmitter.fire();
			}
		} finally {
			this.refreshing = false;
		}
	}

	/** Tries the lookup again later, with growing pauses, so a failed start heals without a manual refresh. */
	private scheduleModelRetry(): void {
		if (this.disposed || this.retryTimer || this.retryAttempt >= MODEL_RETRY_LIMIT) {
			return;
		}
		const delay = Math.min(MODEL_RETRY_BASE_MS * 3 ** this.retryAttempt, MODEL_RETRY_MAX_MS);
		this.retryAttempt++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.disposed || this.cachedModels) {
				return;
			}
			this.log(`Retrying the model lookup (attempt ${this.retryAttempt} of ${MODEL_RETRY_LIMIT}).`);
			void this.lookupModels({ silent: true })
				.then(models => {
					if (models.length > 0 && !this.disposed) {
						this.changeEmitter.fire();
					}
				});
		}, delay);
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		const tools = options.tools ?? [];
		const key = sessionKey(messages);
		const effort = effortOf(options);
		let session = this.sessions.get(key);
		if (session) {
			// Re-insert so the map stays ordered by recency of use.
			this.sessions.delete(key);
			this.sessions.set(key, session);
		}

		if (session && session.model !== model.id) {
			await this.abortTurn(session);
			session = await this.switchModel(key, session, model, tools);
		}
		if (!session) {
			session = await this.createChatSession(key, model, tools);
		}
		this.bridge.updateTools(session.endpoint.token, tools);
		await this.applyEffort(session, effort);

		const fingerprints = messages.map(fingerprint);

		// Copilot ran the tools of the pending turn: hand the results back to the
		// agent and keep streaming the same turn into this response.
		if (session.turn && this.resolveToolResults(session.turn, messages)) {
			await this.driveTurn(key, session, progress, token, fingerprints);
			return;
		}
		if (session.turn) {
			this.log(`The pending turn for ${key} was abandoned; cancelling it.`, 'warn');
			await this.abortTurn(session);
		}

		// A session that has seen nothing yet only gets the current turn, plus a
		// transcript of what came before: the chat may predate this session (window
		// reload, agent restart), and the agent has no other memory of it.
		const lastUser = lastUserMessageIndex(messages);
		let startIndex = session.history.length === 0 ? lastUser : session.history.length;
		let restoreContext = session.history.length === 0;

		if (session.history.length > fingerprints.length || diverged(session.history, fingerprints)) {
			this.log(`Chat history changed for ${key}; starting a fresh ACP session.`);
			await this.destroySession(key);
			session = await this.createChatSession(key, model, tools);
			this.bridge.updateTools(session.endpoint.token, tools);
			await this.applyEffort(session, effort);
			startIndex = lastUser;
			restoreContext = true;
		}

		let blocks = toAcpContentBlocks(messages.slice(startIndex));
		if (blocks.length === 0) {
			blocks = toAcpContentBlocks(messages.slice(lastUser));
		}
		if (restoreContext && lastUser > 0) {
			const transcript = toTranscriptBlock(messages.slice(0, lastUser));
			if (transcript) {
				this.log(`Restoring ${lastUser} earlier message(s) into the new ACP session.`);
				blocks = [transcript, ...blocks];
			}
		}
		if (blocks.length === 0) {
			this.log('The request contained no user text to forward to the agent.', 'warn');
			throw new vscode.LanguageModelError("There is no user message to send to the agent.");
		}

		session.turn = this.startTurn(session, progress, token, blocks);
		await this.driveTurn(key, session, progress, token, fingerprints);
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const text = typeof value === 'string' ? value : textOf(value);
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}

	/** Restarts the agent process; the provider's caches are reset with it. */
	async restart(): Promise<void> {
		await this.agent.restart();
	}

	/**
	 * Resolves this provider's models in the workbench. The model picker of the
	 * Agents window only lists what the agent host advertises, and the host's
	 * BYOK bridge enumerates already-resolved models, so without this the models
	 * would never be published there.
	 */
	async publishModels(): Promise<void> {
		try {
			await vscode.lm.selectChatModels({ vendor: VENDOR });
			this.log('Published models to the workbench.');
		} catch (error) {
			this.log(`Could not publish models: ${describe(error)}`, 'error');
		}
	}

	/**
	 * Starts the agent and asks the workbench to
	 * list the models again. Prompts for sign-in when the agent wants one.
	 */
	async setUp(): Promise<void> {
		await this.agent.setUp();
		try {
			await this.ensureWarmSession();
		} catch (error) {
			if (!this.isSignInRequired(error)) {
				throw error;
			}
		}
		if (this.agent.requiresSignIn) {
			this.promptSignIn();
		}
		this.cachedModels = undefined;
		this.changeEmitter.fire();
	}

	showAccount(): void {
		this.agent.showAccount();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.retryTimer);
		this.agentListener.dispose();
		this.changeEmitter.dispose();
		this.turnEmitter.dispose();
		for (const key of [...this.sessions.keys()]) {
			void this.destroySession(key);
		}
	}

	private async ensureWarmSession(): Promise<AgentSession> {
		if (this.warmSession) {
			return this.warmSession;
		}
		if (!this.warmSessionCreation) {
			this.warmSessionCreation = this.agent.createSession({ cwd: workspaceCwd(), mcpServers: [] })
				.then(session => {
					this.warmSession = session;
					return session;
				})
				.finally(() => {
					this.warmSessionCreation = undefined;
				});
		}
		return this.warmSessionCreation;
	}

	private async createChatSession(key: string, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[]): Promise<ChatSession> {
		const endpoint = await this.bridge.registerSession(tools, (name, input, token) => this.executeTool(key, name, input, token));
		try {
			const acp = await this.agent.createSession({
				cwd: workspaceCwd(),
				mcpServers: [{
					type: 'http',
					name: 'vscode',
					url: endpoint.url,
					headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
				}],
				model: acpModelValue(model.id),
			});

			const session: ChatSession = { acp, endpoint, history: [], model: model.id };
			this.sessions.set(key, session);
			this.log(`Created chat session for ${key} using ${model.id}`);
			this.evictIdleSessions(key);
			return session;
		} catch (error) {
			this.bridge.unregisterSession(endpoint.token);
			throw error;
		}
	}

	private evictIdleSessions(keep: string): void {
		for (const [key, session] of this.sessions) {
			if (this.sessions.size <= MAX_CHAT_SESSIONS) {
				return;
			}
			if (key !== keep && !session.turn) {
				this.log(`Closing the least recently used chat session ${key}.`, 'debug');
				void this.destroySession(key);
			}
		}
	}

	/** Applies the thinking effort the picker reported, when the agent offers one. */
	private async applyEffort(session: ChatSession, effort: string | undefined): Promise<void> {
		if (!effort) {
			return;
		}
		const option = findEffortOption(session.acp.configOptions);
		if (!option || option.currentValue === effort) {
			session.effort = effort;
			return;
		}
		try {
			const configOptions = await this.agent.setConfigOption(session.acp.sessionId, option.id, effort);
			if (configOptions) {
				session.acp.configOptions = configOptions;
			}
			session.effort = effort;
			this.log(`Applied thinking effort "${effort}" to session ${session.acp.sessionId}`);
		} catch (error) {
			this.log(`Could not apply thinking effort "${effort}": ${describe(error)}`, 'warn');
		}
	}

	private startTurn(session: ChatSession, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, blocks: readonly AcpContentBlock[]): ActiveTurn {
		// The prompt's callbacks need the turn, and the turn needs the prompt: it is
		// assigned right below, before any callback can run.
		// eslint-disable-next-line prefer-const
		let turn: ActiveTurn;

		const prompt = this.agent.prompt(session.acp.sessionId, blocks, {
			onText: text => {
				turn.characters += text.length;
				if (turn.streaming) {
					turn.progress.report(new vscode.LanguageModelTextPart(text));
				}
			},
			onThought: text => {
				if (turn.streaming) {
					reportThinking(turn.progress, text);
				}
			},
			onUpdate: (update: AcpSessionUpdate) => {
				if (update.sessionUpdate === 'tool_call') {
					turn.toolCalls++;
				} else if (update.sessionUpdate === 'usage_update') {
					if (typeof update.used === 'number') {
						turn.contextUsed = update.used;
					}
					if (typeof update.size === 'number') {
						turn.contextSize = update.size;
					}
				}
			},
			token,
		}).then(
			result => {
				turn.result = result;
				return result;
			},
			error => {
				turn.error = error;
				throw error;
			},
		).finally(() => {
			turn.finished = true;
			this.wakeTurn(turn);
		});

		turn = {
			progress,
			prompt,
			finished: false,
			streaming: true,
			pending: new Map<string, PendingToolCall>(),
			waiters: [],
			toolCalls: 0,
			characters: 0,
			reportedTokens: 0,
			startedAt: Date.now(),
		};

		// The turn can outlive this request; its failure is reported by the request
		// that continues it, so it must not surface as an unhandled rejection.
		void prompt.catch(() => undefined);
		return turn;
	}

	/** Streams a turn into the current response until it finishes or needs a tool. */
	private async driveTurn(key: string, session: ChatSession, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, fingerprints: readonly string[]): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		turn.progress = progress;
		turn.streaming = true;

		const cancellation = token.onCancellationRequested(() => {
			this.log(`Cancelling the turn for ${key}`);
			this.failPendingToolCalls(turn, new Error("The request was cancelled."));
			this.agent.cancel(session.acp.sessionId);
		});

		try {
			while (!turn.finished) {
				if (turn.pending.size > 0) {
					// Give the agent a moment to issue parallel calls so all of them can
					// travel in this response.
					await delay(PARALLEL_TOOL_WINDOW_MS);
					this.reportUsage(turn);
					turn.streaming = false;
					this.log(`Turn for ${key} asked for ${turn.pending.size} tool call(s); returning them to Copilot.`);
					return;
				}
				await Promise.race([this.sleepUntilActivity(turn), turn.prompt.then(() => undefined, () => undefined)]);
			}
		} finally {
			cancellation.dispose();
		}

		session.turn = undefined;
		this.failPendingToolCalls(turn, new Error("The turn ended before the tool result arrived."));

		if (turn.error) {
			await this.destroySession(key);
			this.log(`Turn failed after ${Date.now() - turn.startedAt}ms: ${describe(turn.error)}`, 'error');

			if (this.isSignInRequired(turn.error)) {
				this.promptSignIn();
				throw new vscode.LanguageModelError("Google ACP needs credentials. Run \"Google ACP: Sign In\" to sign in or to use an API key, then try again.");
			}
			if (turn.error instanceof RpcConnectionClosedError) {
				throw new vscode.LanguageModelError("The Google agent stopped. Send your message again to start a new session; if it keeps happening, run \"Google ACP: Restart Agent\".");
			}
			if (token.isCancellationRequested) {
				return;
			}
			throw new vscode.LanguageModelError(`Google ACP failed: ${describe(turn.error)}`);
		}

		session.history.length = 0;
		session.history.push(...fingerprints);

		this.reportUsage(turn);
		this.turnEmitter.fire();

		const stopReason = turn.result?.stopReason ?? 'unknown';
		this.log(`Turn finished in ${Date.now() - turn.startedAt}ms: ${turn.characters} character(s), ${turn.toolCalls} tool call(s), stop reason "${stopReason}".`);
		if (stopReason === 'cancelled' && !token.isCancellationRequested) {
			this.log('The agent cancelled the turn on its own.', 'warn');
		}
	}

	/**
	 * Reports what the turn spent since the previous report.
	 *
	 * Copilot reads token usage from the `usage` data part, and both the chat
	 * context indicator and the Agents window session info are built on it. Each
	 * response is one request to Copilot, and the indicator shows that request's
	 * prompt as the size of the context, so the prompt count must be the whole
	 * context the agent holds, not what the turn added. The agent's own
	 * `usage_update` carries that size; the per-turn counters only cover tokens
	 * that were not served from the cache and would understate it.
	 */
	private reportUsage(turn: ActiveTurn): void {
		const usage = turn.result?.usage;
		const completionTokens = usage
			? Math.max(0, usage.outputTokens - turn.reportedTokens)
			: Math.max(0, Math.ceil(turn.characters / CHARS_PER_TOKEN) - turn.reportedTokens);

		let promptTokens: number;
		if (turn.contextUsed !== undefined) {
			promptTokens = Math.max(0, turn.contextUsed - completionTokens);
		} else if (usage) {
			promptTokens = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
		} else {
			promptTokens = 0;
		}

		if (promptTokens === 0 && completionTokens === 0) {
			return;
		}

		turn.reportedTokens += completionTokens;

		const payload = {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
			completion_tokens_details: { reasoning_tokens: usage?.reasoningOutputTokens ?? 0 },
		};
		turn.progress.report(vscode.LanguageModelDataPart.json(payload, 'usage'));
		this.log(`Reported usage: ${promptTokens} prompt token(s), ${completionTokens} completion token(s)`);
	}

	/**
	 * Hands a tool call the agent made to the caller of the current request.
	 *
	 * Resolves with `undefined` when no response is open that could carry the
	 * call, so the bridge runs the tool itself.
	 */
	private executeTool(key: string, name: string, input: unknown, token: vscode.CancellationToken): Promise<McpToolResult | undefined> {
		const turn = this.sessions.get(key)?.turn;
		if (!turn || turn.finished || !turn.streaming) {
			this.log(`Tool ${name} was requested without a live response; running it in the extension.`, 'warn');
			return Promise.resolve(undefined);
		}

		const callId = `${TOOL_CALL_ID_PREFIX}${++this.toolCallSeq}`;
		return new Promise<McpToolResult>((resolve, reject) => {
			const cancellation = token.onCancellationRequested(() => {
				turn.pending.delete(callId);
				reject(new Error("The tool call was cancelled."));
			});
			turn.pending.set(callId, {
				resolve: (content, isError) => {
					cancellation.dispose();
					resolve({ content, isError });
				},
				reject: error => {
					cancellation.dispose();
					reject(error);
				},
			});
			turn.progress.report(new vscode.LanguageModelToolCallPart(callId, name, (input ?? {}) as object));
			this.wakeTurn(turn);
		});
	}

	/** Settles pending tool calls with the results Copilot just returned. */
	private resolveToolResults(turn: ActiveTurn, messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
		let resolved = 0;

		// Only the messages after the last assistant reply can answer the pending
		// calls; older results in the history belong to calls that already settled.
		let firstNew = messages.length;
		while (firstNew > 0 && messages[firstNew - 1].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			firstNew--;
		}

		for (const message of messages.slice(firstNew)) {
			if (message.role !== vscode.LanguageModelChatMessageRole.User) {
				continue;
			}
			for (const part of message.content) {
				if (!(part instanceof vscode.LanguageModelToolResultPart)) {
					continue;
				}
				const pending = turn.pending.get(part.callId);
				if (!pending) {
					continue;
				}
				turn.pending.delete(part.callId);
				pending.resolve(part.content, (part as unknown as { isError?: boolean }).isError === true);
				resolved++;
			}
		}

		if (resolved > 0) {
			turn.streaming = true;
			this.log(`Received ${resolved} tool result(s) for the pending turn.`);
		}
		return resolved > 0;
	}

	/** Stops a turn that a new request replaced, so the agent is not left waiting. */
	private async abortTurn(session: ChatSession): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		session.turn = undefined;
		this.failPendingToolCalls(turn, new Error("The turn was abandoned."));
		this.agent.cancel(session.acp.sessionId);
		await Promise.race([turn.prompt.then(() => undefined, () => undefined), delay(ABANDONED_TURN_WAIT_MS)]);
	}

	private failPendingToolCalls(turn: ActiveTurn, error: Error): void {
		for (const pending of turn.pending.values()) {
			pending.reject(error);
		}
		turn.pending.clear();
	}

	private wakeTurn(turn: ActiveTurn): void {
		const waiters = turn.waiters;
		turn.waiters = [];
		for (const wake of waiters) {
			wake();
		}
	}

	private sleepUntilActivity(turn: ActiveTurn): Promise<void> {
		return new Promise<void>(resolve => turn.waiters.push(resolve));
	}

	private async switchModel(key: string, session: ChatSession, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[]): Promise<ChatSession> {
		const modelOption = findModelOption(session.acp.configOptions);
		if (modelOption) {
			try {
				const configOptions = await this.agent.setConfigOption(session.acp.sessionId, modelOption.id, acpModelValue(model.id));
				if (configOptions) {
					session.acp.configOptions = configOptions;
				}
				session.model = model.id;
				this.log(`Switched session for ${key} to ${model.id}`);
				return session;
			} catch (error) {
				this.log(`Could not switch model in place (${describe(error)}); recreating the session.`, 'warn');
			}
		}

		await this.destroySession(key);
		return this.createChatSession(key, model, tools);
	}

	private async destroySession(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) {
			return;
		}
		this.sessions.delete(key);
		if (session.turn) {
			this.failPendingToolCalls(session.turn, new Error("The chat session was closed."));
			session.turn = undefined;
		}
		this.bridge.unregisterSession(session.endpoint.token);
		await this.agent.closeSession(session.acp.sessionId);
	}

	private handleAgentChange(change: AgentChange): void {
		// The sessions lived in the old process in both cases. The next request opens
		// new ones and restores the conversation from Copilot's history.
		this.log(`The agent ${change === 'restarted' ? 'was restarted' : 'exited'}; dropping its sessions.`);
		for (const key of [...this.sessions.keys()]) {
			void this.destroySession(key);
		}
		this.warmSession = undefined;
		this.warmSessionCreation = undefined;

		if (change === 'restarted') {
			// The account may have changed, and with it the models on offer.
			this.cachedModels = undefined;
			this.signInWarningShown = false;
			this.changeEmitter.fire();
		}
	}

	private isSignInRequired(error: unknown): boolean {
		return isAuthRequiredError(error) || this.agent.requiresSignIn;
	}

	private promptSignIn(): void {
		if (this.signInWarningShown) {
			return;
		}
		this.signInWarningShown = true;

		void vscode.window.showWarningMessage(
			"Google ACP needs credentials: sign in with your Antigravity account, or use a Gemini API key.",
			"Sign In",
			"Show Output",
		).then(choice => {
			if (choice === "Sign In") {
				void vscode.commands.executeCommand('googleAcp.signIn');
			} else if (choice === "Show Output") {
				this.output.show(true);
			}
		});
	}

	private log(message: string, level: LogLevel = 'info'): void {
		this.write(message, level);
	}
}

/**
 * Copilot gives a provider no identifier for the chat a request belongs to, so
 * a chat is identified by the workspace plus its opening messages, which never
 * change as the conversation grows. Chats running at once then keep separate
 * ACP sessions and cannot receive each other's output or tool results.
 */
export function sessionKey(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const workspace = folder ? folder.uri.toString() : 'no-workspace';
	const opening = messages.slice(0, 2).map(fingerprint).join('\n');
	return `${workspace}#${createHash('sha1').update(opening).digest('hex').slice(0, 12)}`;
}

/** Reports a thinking chunk when the running VS Code exposes thinking parts. */
function reportThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart) {
		progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
