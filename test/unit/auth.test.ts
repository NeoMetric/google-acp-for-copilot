/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ApiKeyStore, askForApiKey, authenticateMethodFor, pickAuthChoice, validateApiKey } from '../../src/auth';
import { FakeSecretStorage } from './secrets';

describe('authenticateMethodFor', () => {
	const advertised = [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }, { id: 'vertex-ai' }];

	it('uses the API key method when a key is saved', () => {
		expect(authenticateMethodFor(advertised, true)).toBe('gemini-api-key');
	});

	it('otherwise takes the first method that is not the API key', () => {
		expect(authenticateMethodFor(advertised, false)).toBe('oauth-personal');
		expect(authenticateMethodFor([{ id: 'gemini-api-key' }], false)).toBe('gemini-api-key');
	});

	it('is undefined when nothing was advertised', () => {
		expect(authenticateMethodFor([], true)).toBeUndefined();
		expect(authenticateMethodFor([{ name: 'no id' }], false)).toBeUndefined();
	});
});
describe('validateApiKey', () => {
	it('rejects empty or whitespace-containing input', () => {
		expect(validateApiKey('')?.severity).toBe(vscode.InputBoxValidationSeverity.Error);
		expect(validateApiKey('   ')?.severity).toBe(vscode.InputBoxValidationSeverity.Error);
		expect(validateApiKey('AIza a b')?.severity).toBe(vscode.InputBoxValidationSeverity.Error);
	});

	it('warns, but allows, a key without the usual prefix', () => {
		expect(validateApiKey('abc123')?.severity).toBe(vscode.InputBoxValidationSeverity.Warning);
	});

	it('accepts a Gemini key', () => {
		expect(validateApiKey('AIzaSyabc')).toBeUndefined();
		expect(validateApiKey('  AIzaSyabc \n')).toBeUndefined();
	});
});

describe('askForApiKey', () => {
	it('masks the input and trims the result', async () => {
		const box = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('  AIzaSyxyz  ');

		await expect(askForApiKey()).resolves.toBe('AIzaSyxyz');
		expect(box).toHaveBeenCalledWith(expect.objectContaining({ password: true, ignoreFocusOut: true }));
		box.mockRestore();
	});

	it('is undefined when dismissed or blank', async () => {
		const box = vi.spyOn(vscode.window, 'showInputBox');
		box.mockResolvedValueOnce(undefined);
		box.mockResolvedValueOnce('   ');

		await expect(askForApiKey()).resolves.toBeUndefined();
		await expect(askForApiKey()).resolves.toBeUndefined();
		box.mockRestore();
	});
});

describe('pickAuthChoice', () => {
	const pick = (response: (items: Array<{ label: string }>) => unknown) =>
		vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async items => response(items as Array<{ label: string }>) as never);

	it('offers the Google login and the API key', async () => {
		let labels: string[] = [];
		const quickPick = pick(items => { labels = items.map(item => item.label); return items[0]; });

		const choice = await pickAuthChoice(false);

		expect(labels).toEqual(['Google account', 'Gemini API key']);
		expect(choice).toEqual({ kind: 'google-login' });
		quickPick.mockRestore();
	});

	it('offers to replace or remove a saved key', async () => {
		let labels: string[] = [];
		const quickPick = pick(items => { labels = items.map(item => item.label); return items[items.length - 1]; });

		const choice = await pickAuthChoice(true);

		expect(labels.slice(1)).toEqual(['Replace the saved Gemini API key', 'Remove the saved Gemini API key']);
		expect(choice).toEqual({ kind: 'remove-api-key' });
		quickPick.mockRestore();
	});
	it('is undefined when dismissed', async () => {
		const quickPick = pick(() => undefined);

		await expect(pickAuthChoice(false)).resolves.toBeUndefined();
		quickPick.mockRestore();
	});
});

describe('ApiKeyStore', () => {
	it('saves, reads and removes the key through secret storage', async () => {
		const secrets = new FakeSecretStorage();
		const store = new ApiKeyStore(secrets.asSecretStorage());

		expect(await store.get()).toBeUndefined();
		await store.set('AIza1');
		expect(await store.get()).toBe('AIza1');
		await store.clear();
		expect(await store.get()).toBeUndefined();
		store.dispose();
	});

	it('announces changes to its own key only, including ones made elsewhere', async () => {
		const secrets = new FakeSecretStorage();
		const store = new ApiKeyStore(secrets.asSecretStorage());
		const changed = vi.fn();
		store.onDidChange(changed);

		await secrets.store('some.other.secret', 'x');
		expect(changed).not.toHaveBeenCalled();

		secrets.storeFromElsewhere('googleAcp.geminiApiKey', 'AIza2');
		expect(changed).toHaveBeenCalledTimes(1);
		store.dispose();
	});
});
