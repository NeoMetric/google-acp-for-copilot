/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tiny stand-in for an ACP server: speaks newline-delimited JSON-RPC
// on stdio and can be told to misbehave through FAKE_ACP_MODE and the prompt text.

const readline = require('node:readline');

if (process.env.FAKE_ACP_MODE === 'exit-immediately') {
	process.exit(1);
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const awaitingPermission = new Map();
let sessions = 0;
let authenticatedWith;

readline.createInterface({ input: process.stdin }).on('line', line => {
	const message = JSON.parse(line);

	if (message.method === 'initialize') {
		send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }], agentInfo: { name: 'fake', version: '0.0.0' } } });
	} else if (message.method === 'authenticate') {
		authenticatedWith = message.params.methodId;
		send({ jsonrpc: '2.0', id: message.id, result: {} });
	} else if (message.method === 'session/set_config_option') {
		send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: message.params.value, options: [{ value: 'default', name: 'Default' }, { value: 'other', name: 'Other' }] }] } });
	} else if (message.method === 'session/new') {
		send({ jsonrpc: '2.0', id: message.id, result: { sessionId: `s${++sessions}`, configOptions: [{ id: 'model', name: 'Model', 		category: 'model', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'other', name: 'Other' }] }] } });
	} else if (message.method === 'session/close') {
		send({ jsonrpc: '2.0', id: message.id, result: {} });
	} else if (message.method === 'session/prompt') {
		const text = message.params.prompt[0].text;
		const sessionId = message.params.sessionId;

		if (text === 'crash') {
			process.exit(2);
		} else if (text === 'env') {
			send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `env:${process.env.GEMINI_API_KEY ?? 'none'}` } } } });
			send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
		} else if (text === 'auth') {
			send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `auth:${authenticatedWith ?? 'none'}` } } } });
			send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
		} else if (text === 'permission') {
			awaitingPermission.set('perm-1', message.id);
			send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId, toolCall: { title: 'Run a thing' }, options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' }] } });
		} else if (text === 'quota') {
			send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Quota exceeded', data: { details: 'resets in 2h 5m' } } });
		} else if (text === 'native-permission') {
			awaitingPermission.set('perm-1', message.id);
			send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId, toolCall: { title: 'Run ls', kind: 'execute' }, options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' }] } });
		} else {
			send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } } } });
			send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', _meta: { quota: { token_count: { inputTokens: 3, outputTokens: 2 } } } } });
		}
	} else if (message.id !== undefined && awaitingPermission.has(message.id)) {
		const promptId = awaitingPermission.get(message.id);
		awaitingPermission.delete(message.id);
		send({ jsonrpc: '2.0', id: promptId, result: { stopReason: `permission:${JSON.stringify(message.result.outcome)}` } });
	}
});
