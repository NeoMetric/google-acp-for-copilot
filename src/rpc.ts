/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Log } from './logging';

/** A JSON-RPC 2.0 request id as used by ACP. */
export type RpcId = number | string;

export interface RpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

/** ACP's JSON-RPC code for "authentication required". */
export const AUTH_REQUIRED_CODE = -32000;

/** An error returned by the peer, carrying the JSON-RPC code and payload. */
export class RpcError extends Error {

	constructor(message: string, readonly code: number, readonly data?: unknown) {
		super(message);
		this.name = "RpcError";
	}
}

/** Whether `error` is the peer telling us that the user has to sign in. */
export function isAuthRequiredError(error: unknown): boolean {
	return error instanceof RpcError && error.code === AUTH_REQUIRED_CODE;
}

/** Raised for every pending and future request once the connection is gone. */
export class RpcConnectionClosedError extends Error {

	constructor(message = "The ACP connection is closed.") {
		super(message);
		this.name = "RpcConnectionClosedError";
	}
}

/** Raised when the peer does not answer a request within its time limit. */
export class RpcTimeoutError extends Error {

	constructor(readonly method: string, readonly timeoutMs: number) {
		super(`The Google agent did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "RpcTimeoutError";
	}
}

export interface RpcRequestOptions {
	/** Rejects with an {@link RpcTimeoutError} after this long; unset means wait forever. */
	readonly timeoutMs?: number;
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

/**
 * Minimal JSON-RPC 2.0 peer over a pair of node streams, using
 * newline-delimited JSON (the ACP stdio transport) rather than
 * `Content-Length` framing.
 */
export class JsonRpcConnection {

	private readonly pending = new Map<RpcId, PendingRequest>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private notificationHandler: NotificationHandler | undefined;
	private buffer = '';
	private nextId = 1;
	private disposed = false;
	private readonly onData: (chunk: string) => void;
	private readonly onInputClose: () => void;

	constructor(
		private readonly input: NodeJS.ReadableStream,
		private readonly output: NodeJS.WritableStream,
		private readonly log: Log = () => { },
	) {
		this.onData = chunk => this.receive(chunk);
		this.onInputClose = () => this.dispose(new RpcConnectionClosedError("The agent process closed its output."));
		input.setEncoding?.('utf8');
		input.on('data', this.onData);
		input.on('close', this.onInputClose);
		input.on('end', this.onInputClose);
		this.output.on('error', error => this.dispose(error instanceof Error ? error : new Error(String(error))));
	}

	/** Registers the handler for agent -> client requests of `method`. */
	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	/** Registers the single handler for agent -> client notifications. */
	onNotification(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}

	/** Sends a request and resolves with its result, or rejects with an {@link RpcError}. */
	request<T>(method: string, params?: unknown, options: RpcRequestOptions = {}): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new RpcConnectionClosedError());
		}

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const settle = <R>(action: (value: R) => void) => (value: R) => {
				clearTimeout(timer);
				action(value);
			};

			this.pending.set(id, {
				resolve: settle(value => resolve(value as T)),
				reject: settle(reject),
			});

			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (this.pending.delete(id)) {
						reject(new RpcTimeoutError(method, options.timeoutMs!));
					}
				}, options.timeoutMs);
			}

			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Sends a fire-and-forget notification. */
	notify(method: string, params?: unknown): void {
		if (this.disposed) {
			return;
		}
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** Rejects every pending request and stops reading. */
	dispose(reason: Error = new RpcConnectionClosedError()): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.input.off('data', this.onData);
		this.input.off('close', this.onInputClose);
		this.input.off('end', this.onInputClose);

		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(reason);
		}
	}

	private write(message: object): void {
		if (this.disposed) {
			return;
		}
		try {
			this.output.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			this.log(`Failed to write to the agent process: ${error instanceof Error ? error.message : String(error)}`, 'error');
			this.dispose(new RpcConnectionClosedError("The agent process is not writable."));
		}
	}

	private receive(chunk: string): void {
		this.buffer += chunk;

		let newline = this.buffer.indexOf('\n');
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim().length > 0) {
				this.handleLine(line);
			}
			newline = this.buffer.indexOf('\n');
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Only the size is logged: the line may carry conversation text.
			this.log(`Discarding ${line.length} character(s) of malformed agent output`, 'warn');
			return;
		}

		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				this.dispatch(entry);
			}
			return;
		}

		this.dispatch(parsed);
	}

	private dispatch(parsed: unknown): void {
		if (!parsed || typeof parsed !== 'object') {
			return;
		}

		const message = parsed as Record<string, unknown>;
		const hasId = message.id !== undefined && message.id !== null;

		if (typeof message.method === 'string') {
			if (hasId) {
				void this.handleRequest(message.id as RpcId, message.method, message.params);
			} else if (this.notificationHandler) {
				this.notificationHandler(message.method, message.params);
			}
			return;
		}

		if (!hasId) {
			return;
		}

		const pending = this.pending.get(message.id as RpcId);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id as RpcId);

		const error = message.error as RpcErrorObject | undefined;
		if (error) {
			pending.reject(new RpcError(error.message, error.code, error.data));
		} else {
			pending.resolve(message.result);
		}
	}

	private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.respondError(id, -32601, `Method not found: ${method}`);
			return;
		}

		try {
			const result = await handler(params);
			this.write({ jsonrpc: "2.0", id, result: result ?? {} });
		} catch (error) {
			if (error instanceof RpcError) {
				this.write({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, data: error.data } });
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`Request handler for ${method} failed: ${message}`, 'error');
				this.write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
			}
		}
	}

	private respondError(id: RpcId, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}
}
