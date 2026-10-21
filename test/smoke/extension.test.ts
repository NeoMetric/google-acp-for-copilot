/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'NeoMetric.google-acp-for-copilot';

/** Runs inside a real VS Code, with no other extension installed. */
suite('Google ACP smoke test', () => {

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
		await extension.activate();
	});

	test('activates', () => {
		assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
	});

	test('registers every contributed command', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['googleAcp.setUp', 'googleAcp.signIn', 'googleAcp.setApiKey', 'googleAcp.chooseAuthPreference', 'googleAcp.removeApiKey', 'googleAcp.restart', 'googleAcp.showAccount']) {
			assert.ok(commands.includes(command), `${command} is not registered`);
		}
	});

	test('contributes the settings with their defaults', () => {
		const configuration = vscode.workspace.getConfiguration('googleAcp');
		assert.strictEqual(configuration.get('permissionMode'), 'auto');
		assert.strictEqual(configuration.get('authPreference'), 'auto');
		assert.strictEqual(configuration.get('useAgentBuiltInTools'), false);
	});

	test('offers no models, and downloads nothing, before the user sets the agent up', async function () {
		this.timeout(20_000);
		// A silent lookup must come back at once instead of waiting for an npm install.
		const models = await vscode.lm.selectChatModels({ vendor: 'google-acp' });
		assert.deepStrictEqual(models, []);
	});

	test('answers the commands that need no agent', async () => {
		await vscode.commands.executeCommand('googleAcp.showAccount');
	});
});
