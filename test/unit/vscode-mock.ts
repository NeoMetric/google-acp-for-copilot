/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A just-big-enough stand-in for the `vscode` module, so the extension's own
 * logic can be unit tested outside the extension host. Anything it does not
 * cover is exercised by the smoke tests, which run in a real VS Code.
 */

type Listener<T> = (value: T) => unknown;

export class Disposable {
	constructor(private readonly callOnDispose: () => void = () => { }) { }

	dispose(): void {
		this.callOnDispose();
	}
}

export class EventEmitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): Disposable => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

export class CancellationTokenSource {
	private readonly emitter = new EventEmitter<void>();
	private cancelled = false;

	readonly token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: EventEmitter<void>['event'] };

	constructor() {
		const isCancelled = () => this.cancelled;
		this.token = {
			get isCancellationRequested() { return isCancelled(); },
			onCancellationRequested: this.emitter.event,
		};
	}

	cancel(): void {
		if (!this.cancelled) {
			this.cancelled = true;
			this.emitter.fire(undefined);
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export class LanguageModelTextPart {
	constructor(readonly value: string) { }
}

export class LanguageModelDataPart {
	constructor(readonly data: Uint8Array, readonly mimeType: string) { }

	static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
		return new LanguageModelDataPart(data, mimeType);
	}

	static json(value: unknown, mimeType = 'application/json'): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
	}
}

export class LanguageModelToolCallPart {
	constructor(readonly callId: string, readonly name: string, readonly input: object) { }
}

export class LanguageModelToolResultPart {
	constructor(readonly callId: string, readonly content: unknown[]) { }
}

export class LanguageModelError extends Error { }

export class MarkdownString {
	value = '';

	constructor(value?: string, readonly supportThemeIcons?: boolean) {
		this.value = value ?? '';
	}

	appendMarkdown(value: string): this {
		this.value += value;
		return this;
	}
}

export class ThemeColor {
	constructor(readonly id: string) { }
}

export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ProgressLocation { Notification = 15 }
export enum InputBoxValidationSeverity { Info = 1, Warning = 2, Error = 3 }

export const window = {
	createOutputChannel: () => ({}),
	showInformationMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
	showWarningMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
	showErrorMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
	showInputBox: async (..._args: unknown[]): Promise<string | undefined> => undefined,
	showQuickPick: async (..._args: unknown[]): Promise<unknown> => undefined,
	withProgress: async <T>(_options: unknown, task: () => Promise<T>) => task(),
};

/** Setting values by full key (`googleAcp.agent.command`); anything not listed reads as its fallback. */
export const configValues: Record<string, unknown> = {};

export const workspace = {
	workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string; toString(): string } }>,
	getConfiguration: (section?: string) => ({
		get: <T>(key: string, fallback?: T): T | undefined => {
			const full = section ? `${section}.${key}` : key;
			return full in configValues ? configValues[full] as T : fallback;
		},
	}),
	onDidChangeConfiguration: () => ({ dispose() {} }),
};
