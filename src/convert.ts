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

		const text = promptTextOf(message);
		if (text.trim().length > 0) {
			blocks.push({ type: 'text', text });
		}
		blocks.push(...imageBlocksOf(message));
	}

	return blocks;
}

const USER_REQUEST = /<userRequest>([\s\S]*?)<\/userRequest>/;
const ATTACHMENTS = /<attachments>[\s\S]*?<\/attachments>/;
/**
 * Copilot's context for the chat as a whole. It is forwarded once, when a
 * session starts, and kept out of the per-turn text so that it is neither sent
 * again with every message nor repeated in a restored transcript.
 */
const COPILOT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory)>[\s\S]*?<\/\1>/g;
/**
 * What Copilot knows about this turn alone: the clock, the files that changed,
 * the todo list, the terminal, the open editor, and the reminders it repeats
 * next to the request. The agent has no other way to see it, and it is only
 * ever sent with the turn it belongs to.
 */
const TURN_STATE = /<(context|editorContext|reminderInstructions|toolReferences|notebookFormatInstructions)>[\s\S]*?<\/\1>/g;

/**
 * What the user actually said, with the state of the turn it belongs to.
 * Copilot wraps each request in context of its own (environment, workspace
 * layout, memory); the agent has its own for those, so only the request, its
 * attachments and the turn's state are kept. A message that carries that
 * context without a request, as Copilot sends it ahead of the first one, comes
 * out empty.
 */
export function promptTextOf(message: vscode.LanguageModelChatRequestMessage): string {
	const text = textOf(message);
	const request = USER_REQUEST.exec(text);
	if (!request) {
		const withoutContext = text.replace(COPILOT_CONTEXT, '');
		return withoutContext === text ? text : withoutContext.trim();
	}
	const kept: string[] = [];
	// Native puts what the user attached first, then the state of the turn, then the request.
	kept.push(ATTACHMENTS.exec(text)?.[0] ?? '');
	kept.push(...[...text.matchAll(TURN_STATE)].map(match => match[0]));
	kept.push(request[1].trim());
	return kept.filter(part => part).join('\n\n');
}

/**
 * Copilot's context for the whole chat, which it sends ahead of the first
 * request: the environment, the layout of the workspace, the preferences of the
 * user and the memory it loaded. The agent would otherwise never see any of it,
 * and native keeps it in one message that stays in the conversation, so it is
 * forwarded once, when a session that has seen nothing starts.
 */
const CHAT_CONTEXT = /<(environment_info|workspace_info|userMemory|sessionMemory|repoMemory|instructions)>[\s\S]*?<\/\1>/g;

export function chatContextBlock(messages: readonly vscode.LanguageModelChatRequestMessage[]): AcpTextBlock | undefined {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		const text = textOf(message);
		// The message carrying the request is where the conversation starts.
		if (USER_REQUEST.test(text)) {
			break;
		}
		for (const match of text.matchAll(CHAT_CONTEXT)) {
			parts.push(match[0]);
		}
	}

	return parts.length === 0 ? undefined : { type: 'text', text: parts.join('\n\n') };
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

/** The role a system prompt arrives with; the stable API names only `User` and `Assistant`. */
const SYSTEM_ROLE = 3;

/** Whether the host sent this message as its system prompt rather than as part of the conversation. */
export function isSystemMessage(message: vscode.LanguageModelChatRequestMessage): boolean {
	return (message.role as number) === SYSTEM_ROLE;
}

/**
 * A stable description of one Copilot message, used to notice history changes.
 *
 * A system message is described by its role alone. The host renders it afresh
 * for every request, and it has been seen to change between requests of one
 * chat (the casing of a drive letter, for one), which is no change to what was
 * said. Treating that as a rewritten history would start a new session on
 * every turn and lose what the agent had learned.
 */
export function fingerprint(message: vscode.LanguageModelChatRequestMessage): string {
	if (isSystemMessage(message)) {
		return `${message.role}:system`;
	}

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
export const TRANSCRIPT_MAX_CHARACTERS = 40_000;

/**
 * Renders earlier messages as one text block, for an ACP session that did not
 * live through them: after a window reload, an agent restart, or an edit that
 * rewrote the history. The newest messages win when the budget runs out.
 */
export function toTranscriptBlock(messages: readonly vscode.LanguageModelChatRequestMessage[], maxCharacters = TRANSCRIPT_MAX_CHARACTERS): AcpTextBlock | undefined {
	const entries: string[] = [];

	// Copilot's system prompt comes ahead of the first user message, and the role
	// it carries is not reliably `Assistant`, so everything before that message is
	// left out: the agent has a system prompt of its own and must not receive it.
	const firstUser = messages.findIndex(message => message.role === vscode.LanguageModelChatMessageRole.User);
	const history = firstUser < 0 ? [] : messages.slice(firstUser);

	for (const message of history) {
		const lines: string[] = [];

		const text = promptTextOf(message).trim();
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
