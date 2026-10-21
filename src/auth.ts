/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** The `SecretStorage` key a Gemini API key is saved under. */
const API_KEY_SECRET = 'googleAcp.geminiApiKey';

/** What the ACP server advertises for each sign-in method during `initialize`. */
export interface AdvertisedAuthMethod {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
	readonly type?: string;
}

export type AuthChoice =
	| { readonly kind: 'google-login' }
	| { readonly kind: 'api-key' }
	| { readonly kind: 'remove-api-key' };

interface AuthPickItem extends vscode.QuickPickItem {
	readonly choice: AuthChoice;
}

/**
 * The method to hand to ACP `authenticate`, which the server wants before it
 * creates a session. `undefined` when it advertised none.
 */
export function authenticateMethodFor(advertised: readonly AdvertisedAuthMethod[], hasApiKey: boolean): string | undefined {
	const ids = advertised.map(method => method.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
	if (hasApiKey && ids.includes('gemini-api-key')) {
		return 'gemini-api-key';
	}
	return ids.find(id => id !== 'gemini-api-key') ?? ids[0];
}

/** Lets the user pick how to sign in; `undefined` when the picker is dismissed. */
export async function pickAuthChoice(hasApiKey: boolean): Promise<AuthChoice | undefined> {
	const items: AuthPickItem[] = [];

	items.push({
		label: "Google account",
		description: "browser sign-in",
		detail: "Opens Google's sign-in page in your browser. Use the account that has your Antigravity plan; the server keeps the tokens.",
		choice: { kind: 'google-login' },
	});

	items.push({
		label: hasApiKey ? "Replace the saved Gemini API key" : "Gemini API key",
		description: "pay per token",
		detail: "Paste an API key from Google AI Studio. It is kept in VS Code's secret storage and handed to the local agent only.",
		choice: { kind: 'api-key' },
	});

	if (hasApiKey) {
		items.push({
			label: "Remove the saved Gemini API key",
			detail: "Go back to the Google account the server is signed in with.",
			choice: { kind: 'remove-api-key' },
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: "Google ACP: how do you want to sign in?",
		placeHolder: "Choose a sign-in method",
		ignoreFocusOut: true,
	});
	return picked?.choice;
}

/** Checks what was typed into the API key box; a message with a severity, or `undefined` when fine. */
export function validateApiKey(value: string): vscode.InputBoxValidationMessage | undefined {
	const key = value.trim();
	if (key.length === 0) {
		return { message: "Enter the API key.", severity: vscode.InputBoxValidationSeverity.Error };
	}
	if (/\s/.test(key)) {
		return { message: "An API key has no spaces or line breaks.", severity: vscode.InputBoxValidationSeverity.Error };
	}
	if (!key.startsWith('AIza')) {
		return { message: "Gemini API keys usually start with \"AIza\". You can continue if you are sure.", severity: vscode.InputBoxValidationSeverity.Warning };
	}
	return undefined;
}

/** Asks for an API key; `undefined` when the box is dismissed. */
export async function askForApiKey(): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: "Google ACP: Gemini API key",
		prompt: "Paste an API key from Google AI Studio. It is stored in VS Code's secret storage.",
		password: true,
		ignoreFocusOut: true,
		validateInput: validateApiKey,
	});
	const key = value?.trim();
	return key ? key : undefined;
}

/** The API key, kept in VS Code's secret storage (the OS keychain) and never written to settings or logs. */
export class ApiKeyStore implements vscode.Disposable {

	private readonly listener: vscode.Disposable;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	/** Fires when the key was saved or removed, possibly by another window. */
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.listener = secrets.onDidChange(event => {
			if (event.key === API_KEY_SECRET) {
				this.changeEmitter.fire();
			}
		});
	}

	get(): Promise<string | undefined> {
		return Promise.resolve(this.secrets.get(API_KEY_SECRET)).then(value => value || undefined);
	}

	async set(key: string): Promise<void> {
		await this.secrets.store(API_KEY_SECRET, key);
	}

	async clear(): Promise<void> {
		await this.secrets.delete(API_KEY_SECRET);
	}

	dispose(): void {
		this.listener.dispose();
		this.changeEmitter.dispose();
	}
}
