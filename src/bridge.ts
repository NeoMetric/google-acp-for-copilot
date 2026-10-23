/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import type { Log } from './logging';

/** Where an ACP session reaches its own tool set. */
export interface McpServerEndpoint {
	readonly url: string;
	readonly token: string;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The content of one tool call, in the shape the caller returned it. */
export interface McpToolResult {
	readonly content: ReadonlyArray<unknown>;
	readonly isError?: boolean;
}

/**
 * Runs a tool call on behalf of the caller of the language model request.
 *
 * Returns `undefined` when no caller owns the call. The bridge then reports an
 * error to the agent instead of running the tool itself: a tool run without a
 * chat to own it would skip the confirmation Copilot shows for it.
 */
export type McpToolExecutor = (name: string, input: unknown, token: vscode.CancellationToken) => Promise<McpToolResult | undefined>;

interface McpSession {
	readonly tools: readonly vscode.LanguageModelChatTool[];
	readonly execute: McpToolExecutor;
}

interface JsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: number | string | null;
	readonly method?: string;
	readonly params?: unknown;
}

class McpError extends Error {

	constructor(message: string, readonly code: number) {
		super(message);
	}
}

/**
 * Loopback MCP server that exposes the Copilot tools of one chat to the agent.
 *
 * Every ACP session gets its own bearer token, so a session can only see the
 * tools of the chat that created it.
 */
export class McpBridge implements vscode.Disposable {

	private server: http.Server | undefined;
	private starting: Promise<void> | undefined;
	private readonly sessions = new Map<string, McpSession>();
	private disposed = false;

	constructor(private readonly log: Log) { }

	/** Registers a tool set for a new ACP session and returns its endpoint. */
	async registerSession(tools: readonly vscode.LanguageModelChatTool[], execute: McpToolExecutor): Promise<McpServerEndpoint> {
		await this.ensureStarted();

		const token = crypto.randomUUID();
		this.sessions.set(token, { tools, execute });

		const address = this.server?.address() as AddressInfo | null;
		if (!address || typeof address === 'string') {
			throw new Error("The tool bridge is not listening.");
		}

		this.log(`Registered MCP session with ${tools.length} tool(s) on port ${address.port}`);
		return { url: `http://127.0.0.1:${address.port}/`, token };
	}

	/** Replaces the tool set of an existing ACP session. */
	updateTools(token: string, tools: readonly vscode.LanguageModelChatTool[]): void {
		const session = this.sessions.get(token);
		if (session) {
			this.sessions.set(token, { ...session, tools });
		}
	}

	unregisterSession(token: string): void {
		this.sessions.delete(token);
	}

	dispose(): void {
		this.disposed = true;
		this.sessions.clear();
		this.server?.close();
		this.server = undefined;
	}

	private async ensureStarted(): Promise<void> {
		if (this.disposed) {
			throw new Error("The tool bridge has been disposed.");
		}
		if (this.server) {
			return;
		}
		if (!this.starting) {
			this.starting = this.startServer().finally(() => {
				this.starting = undefined;
			});
		}
		return this.starting;
	}

	private startServer(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const server = http.createServer((request, response) => {
				void this.handleRequest(request, response).catch(error => {
					this.log(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
				});
			});

			const onError = (error: Error) => reject(error);
			server.on('error', onError);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', onError);
				server.keepAliveTimeout = 120_000;
				server.headersTimeout = 125_000;
				// A tool call waits for the chat that owns it, which can take as long
				// as a user needs to approve the tool.
				server.requestTimeout = 0;
				this.server = server;
				const address = server.address() as AddressInfo;
				this.log(`MCP tool bridge listening on 127.0.0.1:${address.port}`);
				resolve();
			});
		});
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		// A browser page cannot reach a loopback server it does not know the token of, but
		// refusing foreign Host and Origin headers also closes off DNS rebinding.
		if (request.headers.origin !== undefined || !isLoopbackHost(request.headers.host)) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}

		const session = this.authenticate(request);
		if (!session) {
			sendJson(response, 401, { error: "Unauthorized" });
			return;
		}

		if (request.method !== 'POST') {
			response.setHeader('allow', 'POST');
			sendJson(response, 405, { error: "Method not allowed" });
			return;
		}

		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		if (pathname !== '/' && pathname !== '/mcp') {
			sendJson(response, 404, { error: "Not found" });
			return;
		}

		let body: string;
		try {
			body = await readBody(request);
		} catch (error) {
			sendJson(response, 413, { error: error instanceof Error ? error.message : String(error) });
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			sendJson(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}

		const messages = Array.isArray(parsed) ? parsed as JsonRpcMessage[] : [parsed as JsonRpcMessage];
		const responses: object[] = [];

		for (const message of messages) {
			if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
				if (message && typeof message === 'object' && message.id !== undefined) {
					responses.push({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid request" } });
				}
				continue;
			}
			const result = await this.createResponse(message, session, response);
			if (result) {
				responses.push(result);
			}
		}

		if (responses.length === 0) {
			// Notifications only, e.g. `notifications/initialized`.
			response.writeHead(202, { 'cache-control': 'no-store' });
			response.end();
			return;
		}

		sendJson(response, 200, Array.isArray(parsed) ? responses : responses[0]);
	}

	private authenticate(request: http.IncomingMessage): McpSession | undefined {
		const header = request.headers.authorization;
		if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
			return undefined;
		}

		// The token is a random UUID handed to one ACP session over stdio, and the
		// server only listens on loopback, so a direct lookup is enough.
		return this.sessions.get(header.slice('Bearer '.length));
	}

	private async createResponse(message: JsonRpcMessage, session: McpSession, response: http.ServerResponse): Promise<object | undefined> {
		const id = message.id;
		if (id === undefined || id === null) {
			// A notification needs no answer.
			return undefined;
		}

		try {
			const result = await this.invoke(message, session, response);
			return { jsonrpc: "2.0", id, result };
		} catch (error) {
			if (error instanceof McpError) {
				return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
			}
			const text = error instanceof Error ? error.message : String(error);
			this.log(`MCP request ${message.method} failed: ${text}`, 'error');
			return { jsonrpc: "2.0", id, error: { code: -32603, message: text } };
		}
	}

	private async invoke(message: JsonRpcMessage, session: McpSession, response: http.ServerResponse): Promise<unknown> {
		switch (message.method) {
			case 'initialize':
				return this.initialize(message.params);

			case 'ping':
				return {};

			case 'tools/list':
				this.log(`Listing ${session.tools.length} tool(s) for an agent session`);
				return {
					tools: session.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
					})),
				};

			case 'tools/call':
				return this.callTool(message.params, session, response);

			default:
				throw new McpError(`Method not found: ${message.method}`, -32601);
		}
	}

	private initialize(params: unknown): unknown {
		const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
		const protocolVersion = typeof requested === 'string' && KNOWN_PROTOCOL_VERSIONS.has(requested)
			? requested
			: DEFAULT_PROTOCOL_VERSION;

		return {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'vscode', version: '1.0.0' },
		};
	}

	private async callTool(params: unknown, session: McpSession, response: http.ServerResponse): Promise<unknown> {
		const request = (params ?? {}) as { name?: unknown; arguments?: unknown };
		const name = request.name;
		if (typeof name !== 'string' || name.length === 0) {
			throw new McpError("tools/call requires a tool name", -32602);
		}
		if (!session.tools.some(tool => tool.name === name)) {
			return { content: [{ type: 'text', text: `Tool ${name} is not available in this session.` }], isError: true };
		}

		// Arguments can quote commands and file contents, so they are debug-level.
		this.log(`tools/call ${name} arguments: ${stringify(request.arguments ?? {})}`, 'debug');

		const cancellation = new vscode.CancellationTokenSource();
		const onClose = () => {
			if (!response.writableFinished) {
				cancellation.cancel();
			}
		};
		response.on('close', onClose);

		try {
			// The caller of the language model request owns tool execution: it can
			// run tools this extension cannot see, such as the ones of a Copilot
			// agent session.
			const forwarded = await session.execute(name, request.arguments ?? {}, cancellation.token);
			if (forwarded) {
				this.log(`Returned tool ${name} to the caller of the request`);
				return {
					content: toMcpContent(forwarded.content),
					...(forwarded.isError ? { isError: true } : {}),
				};
			}

			this.log(`Tool ${name} was requested while no chat response could run it; refusing`, 'warn');
			return {
				content: [{ type: 'text', text: `Tool ${name} cannot run right now: no chat request is waiting for it. Ask the user to send a new message.` }],
				isError: true,
			};
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.log(`Tool ${name} failed: ${text}`, 'error');
			return { content: [{ type: 'text', text }], isError: true };
		} finally {
			response.off('close', onClose);
			cancellation.dispose();
		}
	}
}

function isLoopbackHost(host: string | undefined): boolean {
	return host === undefined || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

export function toMcpContent(content: ReadonlyArray<unknown>): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];

	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			blocks.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType.startsWith('image/')) {
				blocks.push({ type: 'image', data: Buffer.from(part.data).toString('base64'), mimeType: part.mimeType });
			} else {
				blocks.push({ type: 'text', text: Buffer.from(part.data).toString('utf8') });
			}
		} else if (typeof part === 'string') {
			blocks.push({ type: 'text', text: part });
		} else if (part !== undefined && part !== null) {
			blocks.push({ type: 'text', text: stringify(part) });
		}
	}

	return blocks;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function readBody(request: http.IncomingMessage): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;

		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
	if (response.headersSent || response.writableEnded || response.destroyed) {
		response.end();
		return;
	}
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(JSON.stringify(body));
}
