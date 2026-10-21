/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { EventEmitter } from './vscode-mock';

/** An in-memory `SecretStorage` that, like the real one, announces changes. */
export class FakeSecretStorage {
	private readonly values = new Map<string, string>();
	private readonly emitter = new EventEmitter<{ key: string }>();
	readonly onDidChange = this.emitter.event;

	get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.values.get(key));
	}

	store(key: string, value: string): Promise<void> {
		this.values.set(key, value);
		this.emitter.fire({ key });
		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		this.values.delete(key);
		this.emitter.fire({ key });
		return Promise.resolve();
	}

	/** A change made by another window: announced, but not through this instance's own calls. */
	storeFromElsewhere(key: string, value: string): void {
		this.values.set(key, value);
		this.emitter.fire({ key });
	}

	asSecretStorage(): vscode.SecretStorage {
		return this as unknown as vscode.SecretStorage;
	}
}
