/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** A text content block as defined by ACP. */
export interface AcpTextBlock {
	readonly type: 'text';
	readonly text: string;
}

/** An image content block as defined by ACP; `data` is base64 encoded. */
export interface AcpImageBlock {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

export type AcpContentBlock = AcpTextBlock | AcpImageBlock;

/**
 * Converts Copilot chat messages into ACP prompt content blocks.
 *
 * Only user text and images are forwarded: tool calls and tool results are
 * ignored, because the agent runs tools itself over the MCP bridge.
 */
export function toAcpContentBlocks(messages: readonly vscode.LanguageModelChatRequestMessage[]): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];

	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}

		const text = textOf(message);
		if (text.trim().length > 0) {
			blocks.push({ type: 'text', text });
		}
		blocks.push(...imageBlocksOf(message));
	}

	return blocks;
}

/** The image blocks of a message, in the order the images were attached. */
export function imageBlocksOf(message: vscode.LanguageModelChatRequestMessage): AcpImageBlock[] {
	const blocks: AcpImageBlock[] = [];

	for (const part of message.content) {
		if (!(part instanceof vscode.LanguageModelDataPart) || !part.mimeType.startsWith('image/')) {
			continue;
		}
		blocks.push({
			type: 'image',
			data: Buffer.from(part.data).toString('base64'),
			mimeType: part.mimeType,
		});
	}

	return blocks;
}

/** Hashes of attachments already seen; every request repeats the whole history. */
const imageHashes = new WeakMap<vscode.LanguageModelDataPart, string>();

/** A short, stable marker for the images of a message, used to spot changes. */
export function imageFingerprint(message: vscode.LanguageModelChatRequestMessage): string {
	const markers: string[] = [];

	for (const part of message.content) {
		if (!(part instanceof vscode.LanguageModelDataPart) || !part.mimeType.startsWith('image/')) {
			continue;
		}
		let digest = imageHashes.get(part);
		if (digest === undefined) {
			digest = hashBytes(part.data);
			imageHashes.set(part, digest);
		}
		markers.push(`${part.mimeType}:${part.data.length}:${digest}`);
	}

	return markers.join(',');
}

/** FNV-1a, enough to notice that two attachments differ. */
function hashBytes(bytes: Uint8Array): string {
	let result = 0x811c9dc5;
	for (let index = 0; index < bytes.length; index++) {
		result ^= bytes[index];
		result = Math.imul(result, 0x01000193);
	}
	return (result >>> 0).toString(16);
}

/** A stable description of one Copilot message, used to notice history changes. */
export function fingerprint(message: vscode.LanguageModelChatRequestMessage): string {
	const parts: string[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelToolCallPart) {
			parts.push(`call:${part.callId}:${part.name}`);
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			parts.push(`result:${part.callId}`);
		}
	}

	return `${message.role}:${textOf(message)}:${imageFingerprint(message)}:${parts.join(',')}`;
}

/** Whether the messages the session has seen are no longer a prefix of the chat. */
export function diverged(history: readonly string[], fingerprints: readonly string[]): boolean {
	for (let index = 0; index < history.length; index++) {
		if (history[index] !== fingerprints[index]) {
			return true;
		}
	}
	return false;
}

/**
 * The newest user message that says something. Messages that only carry tool
 * results are skipped, as there is nothing in them to forward as a prompt.
 */
export function lastUserMessageIndex(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let lastUser = -1;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		if (lastUser < 0) {
			lastUser = index;
		}
		if (textOf(message).trim().length > 0 || imageBlocksOf(message).length > 0) {
			return index;
		}
	}

	return Math.max(lastUser, 0);
}

/** Upper bound for the restored conversation, so a long chat cannot swamp the new turn. */
export const TRANSCRIPT_MAX_CHARACTERS = 100_000;

/**
 * Renders earlier messages as one text block, for an ACP session that did not
 * live through them: after a window reload, an agent restart, or an edit that
 * rewrote the history. The newest messages win when the budget runs out.
 */
export function toTranscriptBlock(messages: readonly vscode.LanguageModelChatRequestMessage[], maxCharacters = TRANSCRIPT_MAX_CHARACTERS): AcpTextBlock | undefined {
	const entries: string[] = [];

	for (const message of messages) {
		const lines: string[] = [];

		const text = textOf(message).trim();
		if (text.length > 0) {
			lines.push(text);
		}

		const calledTools = message.content
			.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
			.map(part => part.name);
		if (calledTools.length > 0) {
			lines.push(`[called tools: ${calledTools.join(', ')}]`);
		}
		if (message.content.some(part => part instanceof vscode.LanguageModelToolResultPart)) {
			lines.push("[tool results omitted]");
		}
		const images = imageBlocksOf(message).length;
		if (images > 0) {
			lines.push(`[${images} image(s) omitted]`);
		}

		if (lines.length > 0) {
			const speaker = message.role === vscode.LanguageModelChatMessageRole.User ? "User" : "Assistant";
			entries.push(`${speaker}: ${lines.join('\n')}`);
		}
	}

	const kept: string[] = [];
	let used = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const remaining = maxCharacters - used;
		if (remaining <= 0) {
			break;
		}
		const entry = entries[index];
		// An entry that does not fit keeps its end, where the latest words are.
		const fitted = entry.length > remaining ? `…${entry.slice(entry.length - remaining + 1)}` : entry;
		kept.unshift(fitted);
		used += fitted.length;
	}

	if (kept.length === 0) {
		return undefined;
	}

	return {
		type: 'text',
		text: [
			"This conversation started before your current session did. What was said so far (oldest first; you have no other memory of it):",
			"<conversation_so_far>",
			kept.join('\n\n'),
			"</conversation_so_far>",
			"The user's current message follows. Respond only to it, using the conversation above as context.",
		].join('\n'),
	};
}

/** Concatenated text of a message, ignoring non-text parts. */
export function textOf(message: vscode.LanguageModelChatRequestMessage): string {
	const parts: string[] = [];

	for (const part of message.content) {
		if (typeof part === 'string') {
			parts.push(part);
		} else if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value);
		}
	}

	return parts.join('\n');
}
