/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { type AcpSessionUpdate, AgentNotFoundError, type AgentChange, type AgentClient, type AgentSession, type PromptResult, workspaceCwd } from './agent';
import { type McpBridge, type McpServerEndpoint, type McpToolResult } from './bridge';
import { carriesToolResults, chatContextBlock, customInstructionsBlock, diverged, fingerprint, isSystemMessage, lastUserMessageIndex, textOf, toAcpContentBlocks, toTranscriptBlock, userWordsAfterReply, type AcpContentBlock } from './convert';
import { scopedLog, type Log, type LogLevel } from './logging';
import { acpModelValue, effortLevelsOf, effortOf, findEffortOption, findModelOption, flattenChoices, toModelVariants } from './models';
import { conversationIdOf, resolveCwd, systemGuidanceOf, workspaceFoldersOf } from './requestContext';
import { isAuthRequiredError, RpcConnectionClosedError } from './rpc';
import { hashAll, isPrefixOf, mismatchOf, SavedSessionStore, shortHash, toolsHashOf, type ReuseCheck, type SavedSession } from './sessionStore';

export const VENDOR = 'google-acp';

const CHARS_PER_TOKEN = 4;

/** Per-process nonce, so call ids from an earlier run in a chat's history never match a new call. */
const TOOL_CALL_ID_PREFIX = `google-acp-${randomBytes(4).toString('hex')}-`;

/** Chat sessions kept alive at once; the least recently used idle one is closed beyond this. */
const MAX_CHAT_SESSIONS = 8;

/**
 * The longest to collect tool calls before handing a turn back to Copilot, so
 * calls the agent issued in parallel travel in the same response.
 */
const PARALLEL_TOOL_WINDOW_MS = 250;
/** How long the tool calls have to stop arriving before a batch is handed over. */
const PARALLEL_TOOL_QUIET_MS = 40;
/** How long to wait for an abandoned turn to end before moving on. */
const ABANDONED_TURN_WAIT_MS = 5_000;
/**
 * A chat that is not being used gives its session back after this long. The chat
 * is resumed or rebuilt from Copilot's transcript on its next message.
 * Settable; 0 keeps sessions until evicted.
 */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
/** How long the session that reads the models lives after its last use. */
const WARM_SESSION_IDLE_MS = 30_000;
const IDLE_SWEEP_MS = 15_000;
/**
 * With no chat session left, the agent process itself is stopped after this long,
 * which also takes down whatever the agent started under it. The next request
 * starts it again. Settable; 0 keeps the agent for the whole window.
 */
const DEFAULT_AGENT_IDLE_MINUTES = 30;

/**
 * How long a tool call may wait for a response to carry it. The agent gives up
 * on a call after three minutes, so failing just before that turns its hard
 * timeout into a clean error, which costs the agent less than an unclear failure.
 */
const TOOL_WAIT_TIMEOUT_MS = 170_000;

/** Failed turns in a row after which a session is replaced, so a broken one cannot trap a chat. */
const MAX_TURN_FAILURES = 3;

/** What Copilot itself tells the model when a tool call did not run. */
const CANCELLED_TOOL_CALL = "The user cancelled the tool call.";

/** One tool call handed to Copilot, settled when its result comes back. */
interface PendingToolCall {
	readonly name: string;
	readonly input: unknown;
	/** Whether a response already carried the call to Copilot. */
	reported: boolean;
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
	readonly sessionId: string;
	result?: PromptResult;
	error?: unknown;
	finished: boolean;
	/** False once the current response returned; late output has nowhere to go. */
	streaming: boolean;
	readonly pending: Map<string, PendingToolCall>;
	/** Cancellations of every request that carried the turn, disposed with it. */
	readonly cancellations: vscode.Disposable[];
	/** When the newest tool call arrived, to spot the end of a batch. */
	lastToolCallAt: number;
	/** Fails the tool calls no response picked up before the agent gives up on them. */
	toolDeadline?: NodeJS.Timeout;
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

/** The workspace a chat belongs to, which can differ from the one the window has open. */
interface ChatContext {
	/** The folders Copilot rendered into the chat, when it rendered any. */
	readonly folders: readonly string[] | undefined;
	/** Where the agent is rooted. */
	readonly cwd: string;
	/** The workspace guidance Copilot rendered into the system message of the request. */
	readonly guidance: string | undefined;
}

interface ChatSession {
	readonly acp: AgentSession;
	readonly endpoint: McpServerEndpoint;
	readonly context: ChatContext;
	readonly history: string[];
	model: string;
	/** Every tool name this session has been offered, so a newly offered tool starts a session that can see it. */
	readonly seenTools: Set<string>;
	/** Whether the session was given the workspace prompt; a request that offers no tools gets none. */
	readonly hasPrompt: boolean;
	/** Hash of the user and mode instructions the agent was last given, so each change is sent once. */
	instructionsHash?: string;
	/** The tools, the guidance and the session prompt the session opened with; a cache hit needs all three unchanged. */
	readonly toolsHash: string;
	readonly guidanceHash: string;
	readonly promptHash: string;
	/** Set when the session continues a stored conversation. Its first turn logs whether the cache served it. */
	reused?: { readonly how: 'resumed'; readonly from: string; logged: boolean };
	/** When the chat last asked for something or finished a turn; a session idle for long enough is released. */
	lastActive: number;
	/** Turns that failed in a row; a turn that finishes resets it. */
	failures: number;
	effort?: string;
	turn?: ActiveTurn;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	inputTokens: number;
	outputTokens: number;
}

/** A stored conversation that a request continues, with the messages it already holds. */
interface Reuse {
	readonly saved: SavedSession;
	readonly history: readonly string[];
}

/**
 * Token metrics for an active chat session. The cache fields are only present
 * when the agent reports per-turn usage; the context fields come from its
 * `usage_update` notifications.
 */
export interface SessionCacheStats {
	readonly hitRate?: number;
	readonly cachedTokens?: number;
	readonly uncachedTokens?: number;
	readonly totalPromptTokens?: number;
	readonly outputTokens?: number;
	readonly contextUsed?: number;
	readonly contextSize?: number;
	readonly model: string;
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

	private readonly cacheStatsEmitter = new vscode.EventEmitter<SessionCacheStats>();
	/** Fires when cache hit statistics for the current chat session are updated. */
	readonly onDidChangeCacheStats = this.cacheStatsEmitter.event;

	private readonly sessions = new Map<string, ChatSession>();
	private readonly saved: SavedSessionStore;
	private readonly agentListener: vscode.Disposable;
	private readonly write: Log;
	private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private toolCallSeq = 0;
	private warmSession: AgentSession | undefined;
	private warmSessionCreation: Promise<AgentSession> | undefined;
	private warmUsedAt = 0;
	/** When the agent was last asked for anything or let go of a session; the idle shutdown counts from here. */
	private lastAgentUse = Date.now();
	/** Sessions being closed; the agent is not stopped under them. */
	private closingCount = 0;
	private sweepTimer: NodeJS.Timeout | undefined;
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
		/** Returns the text to append to the agent's system prompt for a chat that offers these tools. */
		private readonly sessionPrompt?: (tools: readonly vscode.LanguageModelChatTool[], chatFolders?: readonly string[], guidance?: string) => Promise<string | undefined>,
	) {
		this.write = scopedLog(output, 'provider');
		this.saved = new SavedSessionStore(state);
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
			this.lastAgentUse = Date.now();
			this.scheduleIdleSweep();
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

		this.lastAgentUse = Date.now();
		const tools = options.tools ?? [];
		const key = sessionKey(messages, options);
		const context = chatContextOf(messages);
		const effort = effortOf(options);
		const toolNames = tools.map(tool => tool.name);
		this.log(`Request from Copilot: model ${model.id}, ${messages.length} message(s), ${tools.length} tool(s): ${toolNames.join(', ') || 'none'}`);
		let session = this.sessions.get(key);
		if (session) {
			// Re-insert so the map stays ordered by recency of use.
			this.sessions.delete(key);
			this.sessions.set(key, session);
			session.lastActive = Date.now();
		}

		if (session && session.model !== model.id) {
			await this.abortTurn(session);
			session = await this.switchModel(key, session, model, tools, context);
		}
		const fingerprints = messages.map(fingerprint);
		const lastUser = lastUserMessageIndex(messages);

		// Copilot ran the tools of the pending turn: hand the results back to the
		// agent and keep streaming the same turn into this response. The tools of the
		// session stay as they are until the turn ends, so a result is never dropped.
		// A message the user typed while the turn ran comes next to those results. As
		// natively, it ends the turn and starts a new one, so it falls through below.
		const userWords = session?.turn ? userWordsAfterReply(messages) : [];
		if (session && session.turn && userWords.length === 0 && this.resolveToolResults(session.turn, messages)) {
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await this.applyEffort(session, effort);
			this.trackCancellation(session.turn, token);
			await this.driveTurn(key, session, progress, token, fingerprints, lastUser);
			return;
		}
		// The result of a call that already ended, such as one that timed out: the agent
		// went on without it, so the running turn is still the one to answer this request.
		if (session && session.turn && !session.turn.finished && userWords.length === 0 && carriesToolResults(messages)) {
			if (session.turn.pending.size > 0 && [...session.turn.pending.values()].every(call => call.reported)) {
				await this.abortTurn(session);
				throw new vscode.LanguageModelError("A tool result could not be matched to the pending call. Please retry your request.");
			}
			this.log(`Late tool results for ${key}; the turn is still running, so this response continues it.`);
			this.markSeen(session, fingerprints);
			this.applyTools(session, tools);
			await this.applyEffort(session, effort);
			this.trackCancellation(session.turn, token);
			await this.driveTurn(key, session, progress, token, fingerprints, lastUser);
			return;
		}
		if (session?.turn) {
			this.log(`The pending turn for ${key} was abandoned; cancelling it.`, 'warn');
			await this.abortTurn(session);
		}

		if (session && tools.length > 0 && (!session.hasPrompt || offersNewTools(session.seenTools, tools) || guidanceDiffers(session.context.guidance, context.guidance))) {
			// The chat was opened by a request that offered no tools, such as a title,
			// and so got no workspace prompt; or Copilot now offers a tool this session
			// never saw, or describes the chat differently. The agent takes its prompt and
			// its tools when it opens a session, so the chat gets a new one; its messages
			// are restored into it.
			this.log(`Chat ${key} ${session.hasPrompt ? 'changed its tools or its guidance' : 'now offers tools'}; giving it a new session.`);
			await this.destroySession(key);
			session = undefined;
		}
		if (!session) {
			const reuse = tools.length > 0 ? this.findReusable(key, fingerprints, lastUser, tools, context) : undefined;
			session = await this.createChatSession(key, model, tools, context, reuse);
		}
		this.applyTools(session, tools);
		await this.applyEffort(session, effort);

		// A session that has seen nothing yet only gets the current turn, plus a
		// transcript of what came before: the chat may predate this session (window
		// reload, agent restart), and the agent has no other memory of it.
		let startIndex = session.history.length === 0 ? lastUser : session.history.length;
		let restoreContext = session.history.length === 0;

		if (session.history.length > fingerprints.length || diverged(session.history, fingerprints)) {
			this.log(`Chat history changed for ${key}; starting a fresh ACP session.`);
			await this.destroySession(key);
			session = await this.createChatSession(key, model, tools, context);
			this.applyTools(session, tools);
			await this.applyEffort(session, effort);
			startIndex = lastUser;
			restoreContext = true;
		}

		if (restoreContext) {
			this.log(`Roles of the first messages being restored: ${messages.slice(0, 3).map(message => message.role).join(', ')}`, 'debug');
		}

		let blocks = toAcpContentBlocks(messages.slice(startIndex));
		const preamble: AcpContentBlock[] = [];
		if (restoreContext) {
			// The context of the chat comes first, as it does in the prompt the host renders.
			const chatContext = chatContextBlock(messages.slice(0, lastUser));
			if (chatContext) {
				this.log(`Forwarding ${chatContext.text.length} character(s) of context for the chat.`, 'debug');
				preamble.push(chatContext);
			}
		}
		const instructions = customInstructionsBlock(messages);
		const instructionsHash = instructions ? createHash('sha1').update(instructions.text).digest('hex').slice(0, 12) : undefined;
		if (instructions && instructionsHash !== session.instructionsHash) {
			this.log(`Forwarding ${instructions.text.length} character(s) of user and mode instructions.`, 'debug');
			preamble.push(instructions);
			session.instructionsHash = instructionsHash;
		}
		if (restoreContext && lastUser > 0) {
			const transcript = toTranscriptBlock(messages.slice(0, lastUser));
			if (transcript) {
				this.log(`Restoring ${lastUser} earlier message(s) into the new ACP session.`);
				preamble.push(transcript);
			}
		}
		if (preamble.length > 0) {
			blocks = [...preamble, ...blocks];
		}
		if (blocks.length === 0) {
			this.log('The request contained no user text to forward to the agent.', 'warn');
			throw new vscode.LanguageModelError("There is no user message to send to the agent.");
		}

		// The agent has been given everything up to here. A turn that never finishes, because
		// a tool call is abandoned or the user stops it, must not make the next request look
		// like the start of the chat and send the first message again.
		this.markSeen(session, fingerprints);
		session.turn = this.startTurn(session, progress, token, blocks);
		this.trackCancellation(session.turn, token);
		await this.driveTurn(key, session, progress, token, fingerprints, lastUser);
	}

	/** Records that the agent has been given every message of this request. */
	private markSeen(session: ChatSession, fingerprints: readonly string[]): void {
		session.history.length = 0;
		session.history.push(...fingerprints);
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
		clearTimeout(this.sweepTimer);
		this.agentListener.dispose();
		this.changeEmitter.dispose();
		this.turnEmitter.dispose();
		this.cacheStatsEmitter.dispose();
		void this.closeAllSessions();
	}

	async closeAllSessions(): Promise<void> {
		const keys = [...this.sessions.keys()];
		await Promise.allSettled([
			this.closeWarmSession(),
			...keys.map(key => this.destroySession(key)),
		]);
	}

	private async closeWarmSession(): Promise<void> {
		const warm = this.warmSession;
		this.warmSession = undefined;
		this.warmSessionCreation = undefined;
		if (warm) {
			this.lastAgentUse = Date.now();
			await this.agent.closeSession(warm.sessionId);
			this.log(`Closed warm session (${warm.sessionId}).`);
		}
	}

	private async ensureWarmSession(): Promise<AgentSession> {
		this.warmUsedAt = Date.now();
		this.lastAgentUse = this.warmUsedAt;
		if (this.warmSession) {
			return this.warmSession;
		}
		if (!this.warmSessionCreation) {
			this.warmSessionCreation = this.agent.createSession({ cwd: workspaceCwd(), mcpServers: [] })
				.then(session => {
					this.warmSession = session;
					this.warmUsedAt = Date.now();
					this.scheduleIdleSweep();
					return session;
				})
				.finally(() => {
					this.warmSessionCreation = undefined;
				});
		}
		return this.warmSessionCreation;
	}

	private idleTimeoutMs(): number {
		const seconds = vscode.workspace.getConfiguration('googleAcp').get<number>('sessions.idleTimeoutSeconds', DEFAULT_IDLE_TIMEOUT_SECONDS);
		return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : DEFAULT_IDLE_TIMEOUT_SECONDS * 1000;
	}

	/** Arms the sweep for idle sessions; it re-arms itself for as long as a session is left to watch. */
	private scheduleIdleSweep(): void {
		if (this.disposed || this.sweepTimer) {
			return;
		}
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = undefined;
			this.releaseIdleSessions();
			this.stopIdleAgent();
			if (this.sessions.size > 0 || this.warmSession || (this.agent.isRunning && this.agentIdleMs() > 0)) {
				this.scheduleIdleSweep();
			}
		}, IDLE_SWEEP_MS);
		this.sweepTimer.unref();
	}

	/**
	 * Gives back sessions nobody is using. A session with
	 * a turn is never released, including one waiting for Copilot to run a tool.
	 * A released chat gets a new session on its next request.
	 */
	private releaseIdleSessions(): void {
		const now = Date.now();
		const idleMs = this.idleTimeoutMs();
		if (idleMs > 0) {
			for (const [key, session] of [...this.sessions]) {
				if (!session.turn && now - session.lastActive >= idleMs) {
					this.log(`Releasing the idle chat session ${key} (${session.acp.sessionId}); its next message starts a new one.`, 'debug');
					void this.destroySession(key);
				}
			}
		}
		const warm = this.warmSession;
		if (warm && now - this.warmUsedAt >= WARM_SESSION_IDLE_MS) {
			this.warmSession = undefined;
			this.lastAgentUse = now;
			this.log(`Releasing the session that reads models (${warm.sessionId}).`, 'debug');
			void this.agent.closeSession(warm.sessionId);
		}
	}

	private agentIdleMs(): number {
		const minutes = vscode.workspace.getConfiguration('googleAcp').get<number>('agent.idleShutdownMinutes', DEFAULT_AGENT_IDLE_MINUTES);
		return Number.isFinite(minutes) ? Math.max(0, minutes) * 60_000 : DEFAULT_AGENT_IDLE_MINUTES * 60_000;
	}

	/** Stops the agent process when no chat, release or lookup has needed it for the configured time. */
	private stopIdleAgent(): void {
		const idleMs = this.agentIdleMs();
		if (idleMs <= 0 || !this.agent.isRunning) {
			return;
		}
		if (this.sessions.size > 0 || this.closingCount > 0 || this.warmSession || this.warmSessionCreation) {
			return;
		}
		if (Date.now() - this.lastAgentUse < idleMs) {
			return;
		}
		void this.agent.stopWhenIdle();
	}

	private async createChatSession(key: string, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext, reuse?: Reuse): Promise<ChatSession> {
		const endpoint = await this.bridge.registerSession(tools, (name, input, token) => this.executeTool(key, name, input, token));
		try {
			// A request that offers no tools is Copilot's own, such as a chat title: the
			// agent could not read a customization file without a tool, so the prompt
			// would only be paid for in tokens.
			const systemPromptAppend = tools.length === 0
				? undefined
				: await this.buildSessionPrompt(tools, context.folders, context.guidance);
			const options = {
				cwd: context.cwd,
				mcpServers: [{
					type: 'http' as const,
					name: 'vscode',
					url: endpoint.url,
					headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
				}],
				model: acpModelValue(model.id),
				systemPromptAppend,
			};
			const promptHash = shortHash(systemPromptAppend ?? '');

			let acp: AgentSession | undefined;
			let reused: ChatSession['reused'];
			if (reuse) {
				if (reuse.saved.promptHash !== promptHash) {
					this.log(`[reuse] The session prompt differs from the saved one (${reuse.saved.promptHash} -> ${promptHash}); the first model call will show whether the cache still served it.`);
				}
				try {
					acp = await this.agent.resumeSession(reuse.saved.sessionId, options);
					reused = { how: 'resumed', from: reuse.saved.sessionId, logged: false };
					this.log(`[reuse] Resumed ACP session ${acp.sessionId}; the first model call will show whether the cache served it.`);
				} catch (error) {
					this.log(`[reuse] Could not resume saved session ${reuse.saved.sessionId} (${describe(error)}); starting a new session instead.`, 'warn');
					this.saved.forget(key);
				}
			}
			acp ??= await this.agent.createSession(options);

			const history = reuse && reused ? [...reuse.history] : [];
			const session: ChatSession = {
				acp,
				endpoint,
				context,
				history,
				model: model.id,
				seenTools: new Set(tools.map(tool => tool.name)),
				hasPrompt: tools.length > 0,
				toolsHash: toolsHashOf(tools.map(tool => tool.name)),
				guidanceHash: guidanceHashOf(context.guidance),
				promptHash,
				reused,
				failures: 0,
				lastActive: Date.now(),
				cachedReadTokens: 0,
				cachedWriteTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
			};
			this.sessions.set(key, session);
			this.log(`Created chat session for ${key} using ${model.id} in ${context.cwd}${context.folders ? '' : ' (the window\'s folder; the request named none)'}`);
			this.evictIdleSessions(key);
			this.scheduleIdleSweep();
			return session;
		} catch (error) {
			this.bridge.unregisterSession(endpoint.token);
			throw error;
		}
	}

	/**
	 * Looks for a stored conversation that the request continues: this chat's own
	 * after a window reload, or an agent restart. Every step is logged under
	 * "[reuse]" so a reload can be checked in the output.
	 */
	private findReusable(key: string, fingerprints: readonly string[], lastUser: number, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext): Reuse | undefined {
		const check: ReuseCheck = { cwd: context.cwd, toolsHash: toolsHashOf(tools.map(tool => tool.name)), guidanceHash: guidanceHashOf(context.guidance) };
		const incoming = hashAll(fingerprints);
		const all = this.saved.all();
		this.log(`[reuse] No live session for ${key}: ${fingerprints.length} message(s), last user message at ${lastUser}, ${all.length} saved session(s), tools ${check.toolsHash}, guidance ${check.guidanceHash}.`);

		const own = all.find(entry => entry.key === key);
		if (own) {
			const reason = mismatchOf(own, check) ?? (isPrefixOf(own.history, incoming) ? undefined : `the chat no longer starts with the ${own.history.length} saved message(s)`);
			if (!reason) {
				this.log(`[reuse] Saved session ${own.sessionId} matches this chat (${own.history.length} message(s) already in it); resuming it.`);
				return { saved: own, history: fingerprints.slice(0, own.history.length) };
			}
			this.log(`[reuse] Saved session ${own.sessionId} found under this key but not usable: ${reason}.`, 'warn');
		} else {
			this.log('[reuse] Nothing saved under this key.');
		}

		this.log('[reuse] Nothing to continue; starting a new session and restoring the chat as a transcript.');
		return undefined;
	}

	/** Remembers where the conversation of a chat is stored, so a later window can continue it. */
	private remember(key: string, session: ChatSession, fingerprints: readonly string[]): void {
		if (!session.hasPrompt) {
			return;
		}
		this.saved.save({
			key,
			sessionId: session.acp.sessionId,
			cwd: session.context.cwd,
			history: hashAll(fingerprints),
			toolsHash: session.toolsHash,
			guidanceHash: session.guidanceHash,
			promptHash: session.promptHash,
			savedAt: Date.now(),
		});
		this.log(`[reuse] Saved session ${session.acp.sessionId} for ${key}: ${fingerprints.length} message(s).`, 'debug');
	}

	/** A chat still starts when the customization files cannot be read; it just has no extras. */
	private async buildSessionPrompt(tools: readonly vscode.LanguageModelChatTool[], chatFolders: readonly string[] | undefined, guidance: string | undefined): Promise<string | undefined> {
		try {
			return await this.sessionPrompt?.(tools, chatFolders, guidance);
		} catch (error) {
			this.log(`Could not build the session prompt: ${describe(error)}`, 'warn');
			return undefined;
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

	/** Applies the tool set of a request to the session, which tells the agent when it changed. */
	private applyTools(session: ChatSession, tools: readonly vscode.LanguageModelChatTool[]): void {
		// A request that offers no tools is Copilot's own, such as a chat title: it says
		// nothing about what this chat may use, and emptying the list would only make the
		// agent drop tools it still has.
		if (tools.length === 0) {
			return;
		}
		this.bridge.updateTools(session.endpoint.token, tools);
		for (const tool of tools) {
			session.seenTools.add(tool.name);
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
			sessionId: session.acp.sessionId,
			finished: false,
			streaming: true,
			pending: new Map<string, PendingToolCall>(),
			cancellations: [],
			lastToolCallAt: Date.now(),
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
	private async driveTurn(key: string, session: ChatSession, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, fingerprints: readonly string[], lastUser: number): Promise<void> {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		turn.progress = progress;
		turn.streaming = true;
		this.clearToolDeadline(turn);

		try {
			while (!turn.finished) {
				// A call the agent made while no response was open waits here for one.
				this.reportHeldToolCalls(turn);
				if (turn.pending.size > 0) {
					// Give the agent a moment to issue parallel calls so all of them can
					// travel in this response.
					await this.waitForToolCalls(turn);
					this.reportHeldToolCalls(turn);
					this.reportUsage(turn);
					turn.streaming = false;
					this.watchToolCalls(key, session, turn);
					this.log(`Turn for ${key} asked for ${turn.pending.size} tool call(s); returning them to Copilot.`);
					return;
				}
				await Promise.race([this.sleepUntilActivity(turn), turn.prompt.then(() => undefined, () => undefined)]);
			}
		} finally {
			// A response that ended without handing over a tool call leaves the turn
			// without a stream; calls that arrive then wait for the next request.
			if (!turn.finished) {
				turn.streaming = false;
			}
		}

		session.turn = undefined;
		session.lastActive = Date.now();
		this.clearToolDeadline(turn);
		this.disposeCancellations(turn);
		this.failPendingToolCalls(turn, new Error(CANCELLED_TOOL_CALL));

		if (turn.error) {
			this.log(`Turn failed after ${Date.now() - turn.startedAt}ms: ${describe(turn.error)}`, 'error');

			// A failed turn is no reason to drop the session: the agent still holds the
			// conversation, and the next request reads it from the prompt cache instead
			// of paying for all of it again. The messages of the failed turn count as
			// seen, since the agent was given them, except the user message itself:
			// Retry resends the same messages and that one has to reach the agent. A
			// session that keeps failing, a connection that is gone or a missing
			// sign-in is replaced instead.
			session.failures += 1;
			if (keepsSessionAfterFailure(turn.error, session.failures, this.isSignInRequired(turn.error))) {
				session.history.length = 0;
				session.history.push(...fingerprints.slice(0, lastUser));
			} else {
				await this.destroySession(key);
			}

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
		session.failures = 0;
		this.remember(key, session, fingerprints);

		this.reportUsage(turn);
		this.recordSessionUsage(session, turn);
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
		const context = turn.contextUsed !== undefined ? ` (agent context ${turn.contextUsed}/${turn.contextSize ?? '?'})` : '';
		this.log(`Reported usage: ${promptTokens} prompt token(s), ${completionTokens} completion token(s)${context}`);
	}

	private recordSessionUsage(session: ChatSession, turn: ActiveTurn): void {
		const usage = turn.result?.usage;
		if (!usage) {
			if (turn.contextUsed !== undefined) {
				this.cacheStatsEmitter.fire({ contextUsed: turn.contextUsed, contextSize: turn.contextSize, model: session.model });
			}
			return;
		}

		session.cachedReadTokens += usage.cachedReadTokens;
		session.cachedWriteTokens += usage.cachedWriteTokens;
		session.inputTokens += usage.inputTokens;
		session.outputTokens += usage.outputTokens;

		if (session.reused && !session.reused.logged) {
			session.reused.logged = true;
			const prompt = usage.cachedReadTokens + usage.cachedWriteTokens + usage.inputTokens;
			this.log(`[reuse] First turn after the session was resumed from ${session.reused.from}: ${usage.cachedReadTokens.toLocaleString()} of ${prompt.toLocaleString()} prompt token(s) came from the cache.`);
		}

		const totalPrompt = session.cachedReadTokens + session.cachedWriteTokens + session.inputTokens;
		const hitRate = totalPrompt > 0 ? (session.cachedReadTokens / totalPrompt) * 100 : 0;

		const stats: SessionCacheStats = {
			hitRate,
			cachedTokens: session.cachedReadTokens,
			uncachedTokens: session.inputTokens,
			totalPromptTokens: totalPrompt,
			outputTokens: session.outputTokens,
			model: session.model,
		};

		this.log(`Session cache stats: ${hitRate.toFixed(1)}% hit rate (${session.cachedReadTokens.toLocaleString()} cached / ${totalPrompt.toLocaleString()} prompt tokens)`);
		this.cacheStatsEmitter.fire(stats);
	}

	/**
	 * Hands a tool call the agent made to the caller of the current request.
	 *
	 * A call that arrives while no response is open is held until the next one
	 * rather than failed: Copilot only runs the calls of a response it received.
	 *
	 * Resolves with `undefined` when the turn is over, so the bridge reports an
	 * error to the agent instead of running the tool itself.
	 */
	private executeTool(key: string, name: string, input: unknown, token: vscode.CancellationToken): Promise<McpToolResult | undefined> {
		const turn = this.sessions.get(key)?.turn;
		if (!turn || turn.finished) {
			this.log(`Tool ${name} was requested without a turn (${turn ? 'finished' : 'none'}); running it in the extension.`, 'warn');
			return Promise.resolve(undefined);
		}

		const callId = `${TOOL_CALL_ID_PREFIX}${++this.toolCallSeq}`;
		return new Promise<McpToolResult>((resolve, reject) => {
			const cancellation = token.onCancellationRequested(() => {
				turn.pending.delete(callId);
				reject(new Error(CANCELLED_TOOL_CALL));
			});
			turn.pending.set(callId, {
				name,
				input,
				reported: turn.streaming,
				resolve: (content, isError) => {
					cancellation.dispose();
					resolve({ content, isError });
				},
				reject: error => {
					cancellation.dispose();
					reject(error);
				},
			});
			turn.lastToolCallAt = Date.now();

			if (turn.streaming) {
				turn.progress.report(new vscode.LanguageModelToolCallPart(callId, name, (input ?? {}) as object));
				this.wakeTurn(turn);
			} else {
				const held = [...turn.pending.values()].filter(call => !call.reported).length;
				this.log(`Tool ${name} was requested while Copilot runs an earlier call (${turn.pending.size - held} pending, ${held} held); holding it for the next response.`);
			}
		});
	}

	/** Hands the calls that waited for a response to the one that just opened. */
	private reportHeldToolCalls(turn: ActiveTurn): void {
		for (const [callId, call] of turn.pending) {
			if (call.reported) {
				continue;
			}
			call.reported = true;
			turn.progress.report(new vscode.LanguageModelToolCallPart(callId, call.name, (call.input ?? {}) as object));
			this.log(`Handed the held tool call ${call.name} to Copilot.`);
		}
	}

	/** Waits until the agent stops adding calls to the batch, up to the window. */
	private async waitForToolCalls(turn: ActiveTurn): Promise<void> {
		const deadline = Date.now() + PARALLEL_TOOL_WINDOW_MS;
		for (; ;) {
			const quiet = PARALLEL_TOOL_QUIET_MS - (Date.now() - turn.lastToolCallAt);
			const left = Math.min(quiet, deadline - Date.now());
			if (left <= 0) {
				return;
			}
			await delay(left);
		}
	}

	/**
	 * Copilot can stop waiting for a tool call it was handed, for example when its
	 * chat is closed, and nothing else would ever settle the call. Failing it here
	 * beats the agent's own three-minute timeout, which costs it a whole step.
	 */
	private watchToolCalls(key: string, session: ChatSession, turn: ActiveTurn): void {
		this.clearToolDeadline(turn);
		turn.toolDeadline = setTimeout(() => {
			turn.toolDeadline = undefined;
			if (turn.finished || turn.streaming || turn.pending.size === 0) {
				return;
			}
			this.log(`Copilot did not pick up the tool call(s) of ${key} within ${Math.round(TOOL_WAIT_TIMEOUT_MS / 1000)}s; ending the turn.`, 'warn');
			this.failPendingToolCalls(turn, new Error("The chat stopped waiting for this tool call."));
			this.agent.cancel(session.acp.sessionId);
			if (session.turn === turn) {
				session.turn = undefined;
			}
			this.disposeCancellations(turn);
		}, TOOL_WAIT_TIMEOUT_MS);
	}

	private clearToolDeadline(turn: ActiveTurn): void {
		clearTimeout(turn.toolDeadline);
		turn.toolDeadline = undefined;
	}

	/** Keeps a turn stoppable after its response returned to have Copilot run its tools. */
	private trackCancellation(turn: ActiveTurn, token: vscode.CancellationToken): void {
		if (turn.finished) {
			return;
		}
		turn.cancellations.push(token.onCancellationRequested(() => {
			this.log(`Cancelling the turn of ACP session ${turn.sessionId}`);
			this.failPendingToolCalls(turn, new Error(CANCELLED_TOOL_CALL));
			this.agent.cancel(turn.sessionId);
		}));
	}

	private disposeCancellations(turn: ActiveTurn): void {
		for (const cancellation of turn.cancellations) {
			cancellation.dispose();
		}
		turn.cancellations.length = 0;
	}

	/** Settles pending tool calls with the results Copilot just returned. */
	private resolveToolResults(turn: ActiveTurn, messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
		let resolved = 0;

		// A background notification can place an assistant message after the result.
		// Only a result with the pending call's ID can settle it.
		for (const message of messages) {
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
		this.clearToolDeadline(turn);
		this.disposeCancellations(turn);
		this.failPendingToolCalls(turn, new Error(CANCELLED_TOOL_CALL));
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

	private async switchModel(key: string, session: ChatSession, model: vscode.LanguageModelChatInformation, tools: readonly vscode.LanguageModelChatTool[], context: ChatContext): Promise<ChatSession> {
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
		return this.createChatSession(key, model, tools, context);
	}

	private async destroySession(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) {
			return;
		}
		this.sessions.delete(key);
		if (session.turn) {
			this.clearToolDeadline(session.turn);
			this.disposeCancellations(session.turn);
			this.failPendingToolCalls(session.turn, new Error(CANCELLED_TOOL_CALL));
			this.agent.cancel(session.acp.sessionId);
			session.turn = undefined;
		}
		this.bridge.unregisterSession(session.endpoint.token);
		this.closingCount++;
		try {
			await this.agent.closeSession(session.acp.sessionId);
		} finally {
			this.closingCount--;
			this.lastAgentUse = Date.now();
		}
		this.log(`Closed the chat session for ${key} (${session.acp.sessionId}).`);
	}

	private handleAgentChange(change: AgentChange): void {
		// The sessions lived in the old process in both cases. The next request opens
		// new ones and restores the conversation from Copilot's history.
		this.log(`The agent ${change === 'restarted' ? 'was restarted' : 'exited'}; dropping its sessions.`);
		for (const key of [...this.sessions.keys()]) {
			void this.destroySession(key);
		}
		if (change !== 'exited') {
			void this.closeWarmSession();
		} else {
			this.warmSession = undefined;
			this.warmSessionCreation = undefined;
		}

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
 * Whether the session of a failed turn is still usable, and so is worth keeping:
 * the agent holds the conversation, and the next request reads it from the
 * prompt cache instead of paying for the whole of it again. A connection that
 * is gone, a sign-in that is needed or a session that keeps failing leaves
 * nothing to keep, and the next request starts a new session.
 */
export function keepsSessionAfterFailure(error: unknown, failures: number, signedOut: boolean): boolean {
	return !signedOut && !(error instanceof RpcConnectionClosedError) && failures < MAX_TURN_FAILURES;
}

/**
 * Whether Copilot now offers a tool the agent has never been able to call. A
 * session lists its tools when it opens, so a tool offered later can only be
 * reached by opening a session that knows about it.
 */
export function offersNewTools(seen: ReadonlySet<string>, tools: readonly vscode.LanguageModelChatTool[]): boolean {
	return tools.some(tool => !seen.has(tool.name));
}

/**
 * Whether the guidance describing the chat differs from the one the session was
 * given. Copilot renders its system prompt again for every request, and the
 * agent keeps the one it was opened with: a chat that switches between asking
 * and working, or turns autopilot on, would otherwise keep the old rules.
 *
 * Case and spacing are folded, because a host may write the same prompt with a
 * different drive-letter casing and that is no change to what it says.
 */
export function guidanceDiffers(before: string | undefined, after: string | undefined): boolean {
	return squashGuidance(before) !== squashGuidance(after);
}

function squashGuidance(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '/').toLowerCase();
}

function guidanceHashOf(guidance: string | undefined): string {
	return shortHash(squashGuidance(guidance));
}

/**
 * Copilot gives a provider no identifier for the chat a request belongs to, so
 * a chat is identified by the workspace plus its opening messages, which never
 * change as the conversation grows. Chats running at once then keep separate
 * ACP sessions and cannot receive each other's output or tool results.
 *
 * The workspace is the one Copilot rendered into the chat, since a window can
 * show chats of other folders. Copilot's conversation id keeps chats that open
 * with the same words apart; sub-agents of a chat share it but open
 * differently, so they still get sessions of their own.
 */
export function sessionKey(messages: readonly vscode.LanguageModelChatRequestMessage[], options?: vscode.ProvideLanguageModelChatResponseOptions): string {
	const windowFolder = vscode.workspace.workspaceFolders?.[0];
	const workspace = workspaceFoldersOf(messages)?.[0] ?? (windowFolder ? windowFolder.uri.toString() : 'no-workspace');
	const conversation = conversationIdOf(options) ?? '';
	// The system prompt is left out: the host renders it afresh for each request.
	// Only messages before the first assistant reply belong to the opening of the chat;
	// later turns add subsequent user prompts and assistant replies that must not change the key.
	const firstAssistant = messages.findIndex(message => message.role === vscode.LanguageModelChatMessageRole.Assistant);
	const openingMessages = firstAssistant >= 0 ? messages.slice(0, firstAssistant) : messages;
	const opening = openingMessages.filter(message => !isSystemMessage(message)).slice(0, 2).map(fingerprint).join('\n');
	return `${workspace}#${conversation}#${createHash('sha1').update(opening).digest('hex').slice(0, 12)}`;
}

/** The workspace of the chat a request belongs to. */
function chatContextOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatContext {
	const folders = workspaceFoldersOf(messages);
	return { folders, cwd: resolveCwd(folders, workspaceCwd()), guidance: systemGuidanceOf(messages) };
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
