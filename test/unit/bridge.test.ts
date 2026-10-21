/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { McpBridge, toMcpContent, type McpServerEndpoint, type McpToolExecutor } from '../../src/bridge';
import { LanguageModelDataPart, LanguageModelTextPart } from './vscode-mock';

const tools = [
	{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
] as unknown as vscode.LanguageModelChatTool[];

describe('McpBridge', () => {
	let bridge: McpBridge;
	let endpoint: McpServerEndpoint;
	const execute = vi.fn<McpToolExecutor>();

	beforeEach(async () => {
		execute.mockReset();
		bridge = new McpBridge(() => { });
		endpoint = await bridge.registerSession(tools, execute);
	});

	afterEach(() => bridge.dispose());

	const post = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint.url, {
		method: 'POST',
		headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});

	const rpc = async (method: string, params?: unknown) => (await post({ jsonrpc: '2.0', id: 1, method, params })).json() as Promise<Record<string, any>>;

	it('only listens on loopback and hands out a bearer token', () => {
		expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(endpoint.token).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('rejects requests without a valid token', async () => {
		const missing = await fetch(endpoint.url, { method: 'POST', body: '{}' });
		const wrong = await fetch(endpoint.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
		const unregistered = (() => { bridge.unregisterSession(endpoint.token); return post({ jsonrpc: '2.0', id: 1, method: 'ping' }); })();

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect((await unregistered).status).toBe(401);
	});

	it('refuses browser-style requests that carry an Origin or a foreign Host', async () => {
		const withOrigin = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
		expect(withOrigin.status).toBe(403);

		const foreignHost = await new Promise<number>((resolve, reject) => {
			const url = new URL(endpoint.url);
			const request = http.request({ host: url.hostname, port: url.port, method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${endpoint.token}` } }, response => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on('error', reject);
			request.end('{}');
		});
		expect(foreignHost).toBe(403);
	});

	it('only accepts POST', async () => {
		const response = await fetch(endpoint.url, { headers: { authorization: `Bearer ${endpoint.token}` } });

		expect(response.status).toBe(405);
	});

	it('answers initialize with a known protocol version and tool capability', async () => {
		const body = await rpc('initialize', { protocolVersion: '2025-03-26' });

		expect(body.result.protocolVersion).toBe('2025-03-26');
		expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
		expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-06-18');
	});

	it('lists the tools of its own session', async () => {
		const body = await rpc('tools/list');

		expect(body.result.tools).toEqual([{ name: 'read_file', description: 'Reads a file', inputSchema: tools[0].inputSchema }]);
	});

	it('picks up replaced tools', async () => {
		bridge.updateTools(endpoint.token, []);

		expect((await rpc('tools/list')).result.tools).toEqual([]);
	});

	it('forwards a tool call to the executor and returns its content', async () => {
		execute.mockResolvedValue({ content: [new LanguageModelTextPart('file contents')] });

		const body = await rpc('tools/call', { name: 'read_file', arguments: { path: 'a.txt' } });

		expect(execute).toHaveBeenCalledWith('read_file', { path: 'a.txt' }, expect.anything());
		expect(body.result).toEqual({ content: [{ type: 'text', text: 'file contents' }] });
	});

	it('passes the error flag through', async () => {
		execute.mockResolvedValue({ content: [new LanguageModelTextPart('denied')], isError: true });

		expect((await rpc('tools/call', { name: 'read_file' })).result.isError).toBe(true);
	});

	it('refuses to run a tool itself when no response can own the call', async () => {
		execute.mockResolvedValue(undefined);

		const body = await rpc('tools/call', { name: 'read_file' });

		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain('cannot run right now');
	});

	it('reports an executor failure as a tool error', async () => {
		execute.mockRejectedValue(new Error('cancelled by user'));

		const body = await rpc('tools/call', { name: 'read_file' });

		expect(body.result).toEqual({ content: [{ type: 'text', text: 'cancelled by user' }], isError: true });
	});

	it('does not run tools outside the session or without a name', async () => {
		const unknown = await rpc('tools/call', { name: 'delete_everything' });
		expect(unknown.result.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();

		const nameless = await rpc('tools/call', {});
		expect(nameless.error.code).toBe(-32602);
	});

	it('handles ping, unknown methods, notifications, batches and bad JSON', async () => {
		expect((await rpc('ping')).result).toEqual({});
		expect((await rpc('resources/list')).error.code).toBe(-32601);

		const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(notification.status).toBe(202);

		const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])).json() as unknown[];
		expect(batch).toHaveLength(2);

		const bad = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: '{not json' });
		expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32700);
	});

	it('rejects an oversized body', async () => {
		const response = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: 'x'.repeat(9 * 1024 * 1024) }).catch(() => undefined);

		// The server may either answer 413 or drop the connection once the limit is hit.
		expect(response === undefined || response.status === 413).toBe(true);
	});

	it('does not accept sessions after disposal', async () => {
		bridge.dispose();

		await expect(bridge.registerSession(tools, execute)).rejects.toThrow('disposed');
	});
});

describe('toMcpContent', () => {
	it('maps text, images, other data, strings and arbitrary values', () => {
		const content = toMcpContent([
			new LanguageModelTextPart('hi'),
			new LanguageModelDataPart(new Uint8Array([1, 2]), 'image/png'),
			new LanguageModelDataPart(new TextEncoder().encode('{"a":1}'), 'application/json'),
			'plain',
			{ any: 'thing' },
			undefined,
		]);

		expect(content).toEqual([
			{ type: 'text', text: 'hi' },
			{ type: 'image', data: 'AQI=', mimeType: 'image/png' },
			{ type: 'text', text: '{"a":1}' },
			{ type: 'text', text: 'plain' },
			{ type: 'text', text: '{"any":"thing"}' },
		]);
	});
});
