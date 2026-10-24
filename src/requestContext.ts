/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { isSystemMessage, textOf } from './convert';

/**
 * What a request says about the chat it belongs to. Copilot gives a provider
 * no chat or workspace identifier, so the only sources are the text of the
 * messages it rendered and the model options it adds.
 *
 * Two hosts have been seen, and they describe the workspace differently:
 * - the Copilot SDK host puts the chat's working directory in the
 *   `<environment_context>` of its system message, and lists the files of the
 *   workspace under a root path in `<workspace_info>`;
 * - Copilot Chat lists the folders of the workspace in `<workspace_info>`.
 */

const WORKSPACE_INFO = /<workspace_info>([\s\S]*?)<\/workspace_info>/;
const FOLDERS_HEADER = 'I am working in a workspace with the following folders:';
const NO_WORKSPACE = 'There is no workspace currently open.';
const ENVIRONMENT_CONTEXT = /<environment_context>([\s\S]*?)<\/environment_context>/;
const WORKING_DIRECTORY = /^\* Current working directory: (.+?)\s*$/m;
/** The first line of the file listing is the root the paths below it are relative to. */
const STRUCTURE_ROOT = /Initial workspace structure \(file names only\):[ \t]*\r?\n```[^\r\n]*\r?\n([^\r\n]+)/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const ESCAPED_DRIVE_PATH = /^[A-Za-z]:\\\\/;

/**
 * An absolute folder in one spelling, or `undefined` for text that is not an
 * absolute path. Hosts disagree about the casing of a drive letter, even
 * between two requests of one chat, so it is written in lower case.
 */
function normalizeFolder(path: string): string | undefined {
	const trimmed = path.trim();
	if (!ABSOLUTE_PATH.test(trimmed)) {
		return undefined;
	}
	const stripped = trimmed.replace(/[\\/]+$/, '');
	const folder = stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
	return folder.replace(/^[A-Z]:/, drive => drive.toLowerCase());
}

/** The working directory the host names in its system message. */
function systemWorkingDirectory(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	for (const message of messages) {
		if (!isSystemMessage(message)) {
			continue;
		}
		const environment = ENVIRONMENT_CONTEXT.exec(textOf(message))?.[1];
		const directory = environment === undefined ? undefined : WORKING_DIRECTORY.exec(environment)?.[1];
		const folder = directory === undefined ? undefined : normalizeFolder(directory);
		if (folder !== undefined) {
			return folder;
		}
	}
	return undefined;
}

/** The root of the file listing the SDK host renders, which writes each backslash of a Windows path twice. */
function structureRoot(block: string): string | undefined {
	const root = STRUCTURE_ROOT.exec(block)?.[1].trim();
	if (root === undefined) {
		return undefined;
	}
	return normalizeFolder(ESCAPED_DRIVE_PATH.test(root) ? root.replace(/\\\\/g, '\\') : root);
}

/**
 * The folders the chat belongs to, in the order of preference:
 * 1. the working directory in the system message of the SDK host, which is the
 *    folder the host itself runs the chat in;
 * 2. the folders Copilot rendered into the first message of the chat, which it
 *    freezes for the rest of the chat;
 * 3. the root of the file listing in that message.
 *
 * An empty list means Copilot says no workspace is open; `undefined` means the
 * request does not describe one.
 */
export function workspaceFoldersOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] | undefined {
	const working = systemWorkingDirectory(messages);
	if (working !== undefined) {
		return [working];
	}

	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		const block = WORKSPACE_INFO.exec(textOf(message))?.[1];
		if (block === undefined) {
			continue;
		}
		const header = block.indexOf(FOLDERS_HEADER);
		if (header < 0) {
			if (block.includes(NO_WORKSPACE)) {
				return [];
			}
			const root = structureRoot(block);
			return root === undefined ? undefined : [root];
		}

		const folders: string[] = [];
		for (const line of block.slice(header + FOLDERS_HEADER.length).split(/\r?\n/).slice(1)) {
			if (!line.startsWith('- ')) {
				break;
			}
			const folder = normalizeFolder(line.slice(2));
			if (folder !== undefined) {
				folders.push(folder);
			}
		}
		return folders;
	}
	return undefined;
}

/**
 * The identity preamble of a host that writes its system prompt as XML
 * sections. Everything from the first section on is guidance the agent would
 * otherwise never see.
 */
const FIRST_SECTION = /^[ \t]*<[A-Za-z][\w-]*[\s>]/m;
/**
 * The host's own memory rules. They describe the same memory tool this
 * extension writes about, and the section below covers it in the terms of this
 * agent, so keeping both would only repeat it.
 */
const MEMORY_INSTRUCTIONS = /^[ \t]*<memoryInstructions>[\s\S]*?<\/memoryInstructions>[ \t]*$/gm;

/**
 * The guidance the host writes in the system message of the request, which the
 * agent would otherwise never see: its own prompt describes no workspace, and
 * these sections carry the working directory, the rules of the repository, the
 * guidance for the tools it offers, and the preferences of the user for this
 * conversation.
 *
 * The identity preamble is left out, since the agent has a prompt of its own,
 * and so are the host's memory rules, which the appended memory section says
 * again. Text the user or the agent wrote is never read: only a system message
 * counts. A host that sends more than one system message contributes each.
 */
export function systemGuidanceOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	const sections: string[] = [];

	for (const message of messages) {
		if (!isSystemMessage(message)) {
			continue;
		}
		const text = textOf(message);
		const start = FIRST_SECTION.exec(text)?.index;
		if (start === undefined) {
			continue;
		}
		const section = text.slice(start)
			.replace(MEMORY_INSTRUCTIONS, '')
			.trim();
		if (section.length > 0) {
			sections.push(section);
		}
	}

	if (sections.length === 0) {
		return undefined;
	}
	return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The chat id Copilot adds to the model options, when it adds one. */
export function conversationIdOf(options: vscode.ProvideLanguageModelChatResponseOptions | undefined): string | undefined {
	const id = options?.modelOptions?._conversationId;
	return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The folder to root the agent in: the first of the chat's own folders that
 * exists on this machine, otherwise the window's folder.
 */
export function resolveCwd(chatFolders: readonly string[] | undefined, windowCwd: string, exists: (folder: string) => boolean = fs.existsSync): string {
	return chatFolders?.find(folder => exists(folder)) ?? windowCwd;
}
