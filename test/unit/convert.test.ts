/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { diverged, fingerprint, imageFingerprint, lastUserMessageIndex, textOf, toAcpContentBlocks, toTranscriptBlock } from '../../src/convert';
import { assistant, image, toolCall, toolResult, user } from './messages';

describe('textOf', () => {
	it('joins text parts and ignores the rest', () => {
		expect(textOf(user('one', image([1]), 'two'))).toBe('one\ntwo');
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

describe('fingerprint and diverged', () => {
	it('is stable for equal messages and differs when text, role, images or tools differ', () => {
		expect(fingerprint(user('a'))).toBe(fingerprint(user('a')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(user('b')));
		expect(fingerprint(user('a'))).not.toBe(fingerprint(assistant('a')));
		expect(fingerprint(user('a', image([1])))).not.toBe(fingerprint(user('a', image([2]))));
		expect(fingerprint(assistant(toolCall('1', 'x')))).not.toBe(fingerprint(assistant(toolCall('2', 'x'))));
		expect(fingerprint(user(toolResult('1')))).not.toBe(fingerprint(user(toolResult('2'))));
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
