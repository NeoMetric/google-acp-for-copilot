/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelChatMessageRole, LanguageModelDataPart, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart } from './vscode-mock';

type Content = string | LanguageModelDataPart | LanguageModelToolCallPart | LanguageModelToolResultPart;

function message(role: LanguageModelChatMessageRole, ...content: Content[]): vscode.LanguageModelChatRequestMessage {
	return {
		role: role as unknown as vscode.LanguageModelChatMessageRole,
		name: undefined,
		content: content.map(part => typeof part === 'string' ? new LanguageModelTextPart(part) : part) as unknown as vscode.LanguageModelChatRequestMessage['content'],
	};
}

export const user = (...content: Content[]) => message(LanguageModelChatMessageRole.User, ...content);
export const assistant = (...content: Content[]) => message(LanguageModelChatMessageRole.Assistant, ...content);
/** A role the stable API does not name, such as the one a system prompt can arrive with. */
export const system = (...content: Content[]) => message(3 as LanguageModelChatMessageRole, ...content);
export const image = (bytes: number[], mimeType = 'image/png') => new LanguageModelDataPart(new Uint8Array(bytes), mimeType);
export const toolCall = (callId: string, name: string) => new LanguageModelToolCallPart(callId, name, {});
export const toolResult = (callId: string) => new LanguageModelToolResultPart(callId, [new LanguageModelTextPart('output')]);
