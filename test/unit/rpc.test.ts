/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_CODE, isAuthRequiredError, JsonRpcConnection, RpcConnectionClosedError, RpcError, RpcTimeoutError } from '../../src/rpc';

/** The agent's side of the pipes: what it receives, and a way to send. */
function createPipes() {
	const fromAgent = new PassThrough();
	const toAgent = new PassThrough();
	const received: Array<Record<string, unknown>> = [];
	let buffer = '';
	toAgent.setEncoding('utf8');
	toAgent.on('data', (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf('\n');
		while (index !== -1) {
			received.push(JSON.parse(buffer.slice(0, index)));
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf('\n');
		}
	});
	const send = (message: unknown) => fromAgent.write(`${JSON.stringify(message)}\n`);
	return { fromAgent, toAgent, received, send };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('JsonRpcConnection', () => {
	let pipes: ReturnType<typeof createPipes>;
	let connection: JsonRpcConnection;
	const log = vi.fn();

	beforeEach(() => {
		pipes = createPipes();
		connection = new JsonRpcConnection(pipes.fromAgent, pipes.toAgent, log);
		log.mockClear();
	});

	afterEach(() => connection.dispose());

	it('matches a response to its request', async () => {
		const pending = connection.request<{ ok: boolean }>('ping', { a: 1 });
		await tick();
		expect(pipes.received[0]).toMatchObject({ jsonrpc: '2.0', method: 'ping', params: { a: 1 } });

		pipes.send({ jsonrpc: '2.0', id: pipes.received[0].id, result: { ok: true } });
		await expect(pending).resolves.toEqual({ ok: true });
	});

	it('rejects with an RpcError carrying the code and data', async () => {
		const pending = connection.request('boom');
		await tick();
		pipes.send({ jsonrpc: '2.0', id: pipes.received[0].id, error: { code: AUTH_REQUIRED_CODE, message: 'sign in', data: { x: 1 } } });

		const error = await pending.catch(caught => caught);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toMatchObject({ code: AUTH_REQUIRED_CODE, message: 'sign in', data: { x: 1 } });
		expect(isAuthRequiredError(error)).toBe(true);
		expect(isAuthRequiredError(new Error('sign in'))).toBe(false);
	});

	it('reassembles a message split across chunks and handles several per chunk', async () => {
		const first = connection.request<number>('a');
		const second = connection.request<number>('b');
		await tick();
		const [idA, idB] = pipes.received.map(message => message.id);

		const whole = `${JSON.stringify({ jsonrpc: '2.0', id: idA, result: 1 })}\n${JSON.stringify({ jsonrpc: '2.0', id: idB, result: 2 })}\n`;
		pipes.fromAgent.write(whole.slice(0, 17));
		pipes.fromAgent.write(whole.slice(17));

		await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
	});

	it('answers requests from the agent through a registered handler', async () => {
		connection.onRequest('session/request_permission', params => ({ echoed: params }));
		pipes.send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { tool: 'x' } });
		await tick();
		await tick();

		expect(pipes.received).toContainEqual({ jsonrpc: '2.0', id: 'p1', result: { echoed: { tool: 'x' } } });
	});

	it('answers an unknown method with "method not found"', async () => {
		pipes.send({ jsonrpc: '2.0', id: 7, method: 'nope' });
		await tick();
		await tick();

		expect(pipes.received[0]).toMatchObject({ id: 7, error: { code: -32601 } });
	});

	it('reports a failing handler as an internal error', async () => {
		connection.onRequest('fail', () => { throw new Error('kaput'); });
		pipes.send({ jsonrpc: '2.0', id: 8, method: 'fail' });
		await tick();
		await tick();

		expect(pipes.received[0]).toMatchObject({ id: 8, error: { code: -32603, message: 'kaput' } });
	});

	it('delivers notifications and ignores malformed lines without leaking their text', async () => {
		const seen: Array<[string, unknown]> = [];
		connection.onNotification((method, params) => seen.push([method, params]));

		pipes.fromAgent.write('this is not json SECRET\n');
		pipes.send({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } });
		await tick();

		expect(seen).toEqual([['session/update', { n: 1 }]]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('malformed'), 'warn');
		expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
	});

	it('handles a batch of messages', async () => {
		const pending = connection.request<string>('x');
		await tick();
		pipes.send([{ jsonrpc: '2.0', id: pipes.received[0].id, result: 'done' }]);

		await expect(pending).resolves.toBe('done');
	});

	it('rejects with a timeout when the agent stays silent, and ignores the late answer', async () => {
		const pending = connection.request('slow', undefined, { timeoutMs: 20 });
		await tick();
		const id = pipes.received[0].id;

		await expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
		pipes.send({ jsonrpc: '2.0', id, result: 'late' });
		await tick();
	});

	it('does not time out a request that is answered in time', async () => {
		const pending = connection.request('quick', undefined, { timeoutMs: 1000 });
		await tick();
		pipes.send({ jsonrpc: '2.0', id: pipes.received[0].id, result: 'fine' });

		await expect(pending).resolves.toBe('fine');
	});

	it('rejects pending requests, and later ones, once disposed', async () => {
		const pending = connection.request('waiting');
		connection.dispose(new RpcConnectionClosedError('gone'));

		await expect(pending).rejects.toThrow('gone');
		await expect(connection.request('again')).rejects.toBeInstanceOf(RpcConnectionClosedError);
	});

	it('closes when the agent output ends', async () => {
		const pending = connection.request('waiting');
		pipes.fromAgent.end();

		await expect(pending).rejects.toBeInstanceOf(RpcConnectionClosedError);
	});
});
