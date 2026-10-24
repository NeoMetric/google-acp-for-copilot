/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { chatContextBlock, diverged, fingerprint, imageFingerprint, lastUserMessageIndex, promptTextOf, textOf, toAcpContentBlocks, toTranscriptBlock } from '../../src/convert';
import { assistant, image, system, toolCall, toolResult, user } from './messages';

describe('textOf', () => {
	it('joins text parts and ignores the rest', () => {
		expect(textOf(user('one', image([1]), 'two'))).toBe('one\ntwo');
	});
});

describe('promptTextOf', () => {
	it('extracts attachments, the state of the turn and the request when wrapped in Copilot tags', () => {
		const raw = '<environment_info>env</environment_info>\n<editorContext>file.ts</editorContext>\n<attachments>att</attachments>\n<userRequest>do work</userRequest>';
		expect(promptTextOf(user(raw))).toBe('<attachments>att</attachments>\n\n<editorContext>file.ts</editorContext>\n\ndo work');
	});

	it('strips Copilot context when userRequest tag is absent', () => {
		const raw = '<userMemory>mem</userMemory>\nclean text';
		expect(promptTextOf(user(raw))).toBe('clean text');
	});
});

describe('toAcpContentBlocks', () => {
	it('forwards user text and images, skipping assistant messages and blank text', () => {
		const blocks = toAcpContentBlocks([
			user('hello', image([1, 2, 3])),
			assistant('an answer'),
			user('   '),
		]);

		expect(blocks).toEqual([
			{ type: 'text', text: 'hello' },
			{ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
		]);
	});
});

describe('toAcpContentBlocks context stripping', () => {
	it('forwards the user request, its attachments and the state of the turn', () => {
		const blocks = toAcpContentBlocks([
			user('<context><current_datetime>now</current_datetime></context><attachments><attachment id="a">file</attachment></attachments><userRequest>fix it</userRequest>'),
		]);

		expect(blocks).toEqual([
			{ type: 'text', text: '<attachments><attachment id="a">file</attachment></attachments>\n\n<context><current_datetime>now</current_datetime></context>\n\nfix it' },
		]);
	});

	it('keeps the state of the turn, its reminders and the tools the user pointed at', () => {
		const turn = user([
			'<toolReferences>The user attached read_file to this message.</toolReferences>',
			'<notebookFormatInstructions>Use cell ids.</notebookFormatInstructions>',
			'<context>',
			'<current_datetime>2026-10-24T12:50:54.417+05:30</current_datetime>',
			'<editedFileEvents>edited src/a.ts</editedFileEvents>',
			'<todoList>- [ ] fix the bug</todoList>',
			'<terminalState>npm test is running</terminalState>',
			'</context>',
			'<editorContext>src/b.ts is open</editorContext>',
			'<reminderInstructions>Use the todo tool for every step.</reminderInstructions>',
			'<userRequest>continue</userRequest>',
		].join('\n'));

		const block = toAcpContentBlocks([turn])[0];
		const text = block?.type === 'text' ? block.text : '';

		expect(text).toContain('edited src/a.ts');
		expect(text).toContain('- [ ] fix the bug');
		expect(text).toContain('npm test is running');
		expect(text).toContain('src/b.ts is open');
		expect(text).toContain('Use the todo tool for every step.');
		expect(text).toContain('attached read_file');
		expect(text).toContain('Use cell ids.');
		expect(text).toContain('continue');
		expect(text.indexOf('2026-10-24')).toBeLessThan(text.indexOf('continue'));
	});

	it('still drops the context that describes the chat once, which the agent has its own of', () => {
		const text = toAcpContentBlocks([user(
			'<workspace_info>tree</workspace_info><userMemory>notes</userMemory><sessionMemory>x</sessionMemory><userRequest>go</userRequest>',
		)])[0];

		expect(text).toEqual({ type: 'text', text: 'go' });
	});
});

describe('chatContextBlock', () => {
	it('forwards the context Copilot sends ahead of the first request', () => {
		const block = chatContextBlock([
			system('You are Copilot.'),
			user('<environment_info>Linux</environment_info>\n<workspace_info>tree</workspace_info>\n<userMemory>notes</userMemory>'),
			user('<context>now</context><userRequest>go</userRequest>'),
		]);

		expect(block).toEqual({
			type: 'text',
			text: '<environment_info>Linux</environment_info>\n\n<workspace_info>tree</workspace_info>\n\n<userMemory>notes</userMemory>',
		});
	});

	it('is undefined for a host that keeps its context in the system prompt', () => {
		expect(chatContextBlock([system('<environment_context>Go.</environment_context>'), user('<userRequest>go</userRequest>')])).toBeUndefined();
	});

	it('stops at the first request, so a turn is never taken for the chat context', () => {
		expect(chatContextBlock([user('<userRequest>one</userRequest>'), user('<workspace_info>tree</workspace_info>')])).toBeUndefined();
	});

	it('joins every context message Copilot sends ahead of the request, in order', () => {
		const block = chatContextBlock([
			user('<environment_info>Linux</environment_info>'),
			user('<workspace_info>tree</workspace_info>'),
			user('<context>now</context><userRequest>go</userRequest>'),
		]);

		expect(block).toEqual({ type: 'text', text: '<environment_info>Linux</environment_info>\n\n<workspace_info>tree</workspace_info>' });
	});
});

describe('prompt edge cases', () => {
	it('keeps the state of the turn when the request itself is empty, as native sends it', () => {
		expect(toAcpContentBlocks([user('<context>x</context><userRequest>   </userRequest>')]))
			.toEqual([{ type: 'text', text: '<context>x</context>' }]);
	});

	it('forwards an unclosed request wrapper as written, rather than dropping it', () => {
		expect(toAcpContentBlocks([user('<userRequest>half a thought')])).toEqual([{ type: 'text', text: '<userRequest>half a thought' }]);
	});

	it('keeps the state of a turn the host sends without a request wrapper', () => {
		const block = toAcpContentBlocks([user('<current_datetime>2026-10-24T12:50:54.417+05:30</current_datetime>\n\nwhat changed?')])[0];
		const text = block?.type === 'text' ? block.text : '';

		expect(text).toContain('2026-10-24T12:50:54.417+05:30');
		expect(text).toContain('what changed?');
	});
});

describe('fingerprint and diverged', () => {
	it('is stable for equal messages and differs when text, role, images or tools differ', () => {
		expect(fingerprint(user('a'))).toBe(fingerprint(user('a')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(user('b')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(assistant('a')));
		expect(fingerprint(user('a', image([1])))).not.toBe(fingerprint(user('a', image([2]))));
		expect(fingerprint(assistant(toolCall('1', 'x')))).not.toBe(fingerprint(assistant(toolCall('2', 'x'))));
		expect(fingerprint(user(toolResult('1')))).not.toBe(fingerprint(user(toolResult('2'))));
	});

	it('does not let the text of a system message change the fingerprint', () => {
		// The host re-renders its system prompt between requests (for example the
		// casing of a drive letter), and that is not a change to the conversation.
		const first = system('Git repository root: C:\\repo');
		const second = system('Git repository root: c:\\repo');

		expect(fingerprint(first)).toBe(fingerprint(second));
		expect(fingerprint(first)).not.toBe(fingerprint(user('Git repository root: C:\\repo')));
	});

	it('keeps a chat undiverged when only its system message was re-rendered', () => {
		const before = [system('root: C:\\repo'), user('hi')].map(fingerprint);
		const after = [system('root: c:\\repo'), user('hi'), assistant('hello'), user('more')].map(fingerprint);

		expect(diverged(before, after)).toBe(false);
	});

	it('hashes an image part once', () => {
		const part = image([9, 9, 9]);
		const first = imageFingerprint(user(part));
		expect(imageFingerprint(user(part))).toBe(first);
	});

	it('detects a rewritten history but not a longer one', () => {
		expect(diverged(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
		expect(diverged(['a', 'b'], ['a', 'x', 'c'])).toBe(true);
		expect(diverged(['a', 'b'], ['a'])).toBe(true);
		expect(diverged([], [])).toBe(false);
	});
});

describe('lastUserMessageIndex', () => {
	it('finds the newest user message', () => {
		expect(lastUserMessageIndex([user('a'), assistant('b'), user('c')])).toBe(2);
	});

	it('skips messages that only carry tool results', () => {
		expect(lastUserMessageIndex([user('ask'), assistant(toolCall('1', 't')), user(toolResult('1'))])).toBe(0);
	});

	it('accepts an image-only message', () => {
		expect(lastUserMessageIndex([user('a'), assistant('b'), user(image([1]))])).toBe(2);
	});

	it('falls back to the last user message, then to 0', () => {
		expect(lastUserMessageIndex([assistant('b'), user(toolResult('1'))])).toBe(1);
		expect(lastUserMessageIndex([assistant('b')])).toBe(0);
		expect(lastUserMessageIndex([])).toBe(0);
	});
});

describe('toTranscriptBlock', () => {
	it('is undefined when there is nothing to restore', () => {
		expect(toTranscriptBlock([])).toBeUndefined();
	});

	it('renders speakers, tool calls and omitted content in order', () => {
		const block = toTranscriptBlock([
			user('first question', image([1])),
			assistant('thinking', toolCall('1', 'read_file')),
			user(toolResult('1')),
			assistant('the answer'),
		]);

		expect(block?.type).toBe('text');
		const text = block!.text;
		expect(text).toContain('<conversation_so_far>');
		expect(text.indexOf('User: first question')).toBeLessThan(text.indexOf('Assistant: thinking'));
		expect(text).toContain('[1 image(s) omitted]');
		expect(text).toContain('[called tools: read_file]');
		expect(text).toContain('[tool results omitted]');
		expect(text).toContain('Assistant: the answer');
	});

	it('keeps the newest messages when over budget', () => {
		const block = toTranscriptBlock([user('OLDEST ' + 'x'.repeat(200)), assistant('middle ' + 'y'.repeat(200)), user('NEWEST')], 60);

		expect(block!.text).toContain('User: NEWEST');
		expect(block!.text).not.toContain('OLDEST');
	});

	it('truncates a single oversized message from the front', () => {
		const block = toTranscriptBlock([user('BEGIN ' + 'z'.repeat(500) + ' END')], 50);

		expect(block!.text).toContain('END');
		expect(block!.text).not.toContain('BEGIN');
		expect(block!.text).toContain('…');
	});
});
