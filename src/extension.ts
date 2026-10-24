/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentClient } from './agent';
import { ApiKeyStore } from './auth';
import { McpBridge } from './bridge';
import { GoogleAcpProvider, VENDOR } from './provider';
import { scopedLog } from './logging';
import { killAllChildren } from './processes';
import { formatReset, type QuotaLimit } from './quota';
import { createSessionPrompt } from './systemPrompt';

/** Set once the first-run explanation of a missing ACP server was shown, so it is never repeated. */
const SETUP_OFFERED_KEY = 'googleAcp.setupOffered';
/** Set once the terms-of-service notice was shown, so it is never repeated. */
const NOTICE_SHOWN_KEY = 'googleAcp.noticeShown';

let activeProvider: GoogleAcpProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Google ACP", { log: true });
	const log = scopedLog(output);

	const bridge = new McpBridge(scopedLog(output, 'bridge'));
	const apiKeys = new ApiKeyStore(context.secrets);
	const agent = new AgentClient(context, output, apiKeys);
	const provider = new GoogleAcpProvider(agent, bridge, output, context.globalState, createSessionPrompt(scopedLog(output, 'prompt'), path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'prompts')));
	activeProvider = provider;

	const reportFailure = (what: string, error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		log(`${what}: ${reason}`, 'error');
		void vscode.window.showErrorMessage(`Google ACP ${what}: ${reason}`);
	};

	const limitItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	limitItem.command = 'googleAcp.showAccount';
	let limitTimer: NodeJS.Timeout | undefined;
	const showLimit = (limit: QuotaLimit | undefined) => {
		clearTimeout(limitTimer);
		if (!limit) {
			limitItem.hide();
			return;
		}
		const reset = limit.resetAt !== undefined ? ` Resets ${formatReset(limit.resetAt)}.` : '';
		limitItem.text = "$(warning) Antigravity limit";
		limitItem.tooltip = `Your Antigravity usage limit is reached.${reset}`;
		limitItem.show();
		if (limit.resetAt !== undefined) {
			limitTimer = setTimeout(() => limitItem.hide(), Math.min(Math.max(limit.resetAt - Date.now(), 0), 2 ** 31 - 1));
		}
	};

	context.subscriptions.push(
		output,
		limitItem,
		{ dispose: () => clearTimeout(limitTimer) },
		agent.onDidChangeLimit(showLimit),
		bridge,
		apiKeys,
		agent,
		provider,
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
		vscode.commands.registerCommand('googleAcp.setUp', async () => {
			try {
				await showNoticeOnce(context);
				await provider.setUp();
			} catch (error) {
				reportFailure("could not set up the Google agent", error);
			}
		}),
		vscode.commands.registerCommand('googleAcp.signIn', async () => {
			try {
				await agent.signIn();
			} catch (error) {
				reportFailure("could not start the sign-in flow", error);
			}
		}),
		vscode.commands.registerCommand('googleAcp.setApiKey', async () => {
			try {
				await agent.setApiKey();
			} catch (error) {
				reportFailure("could not save the API key", error);
			}
		}),
		vscode.commands.registerCommand('googleAcp.chooseAuthPreference', async () => {
			const config = vscode.workspace.getConfiguration('googleAcp');
			const current = config.get<string>('authPreference', 'auto');
			const options = [
				{ value: 'auto', label: "Automatic", detail: "Use the saved API key if there is one, otherwise the signed-in account." },
				{ value: 'apiKey', label: "API key", detail: "Use the saved Gemini API key." },
				{ value: 'oauth', label: "Signed-in account", detail: "Ignore the saved API key and any GEMINI_API_KEY in the environment." },
			];
			const picked = await vscode.window.showQuickPick(
				options.map(option => ({ ...option, description: option.value === current ? "current" : undefined })),
				{ title: "Google ACP: which credentials should the agent use?", placeHolder: "Choose credentials" },
			);
			if (picked && picked.value !== current) {
				await config.update('authPreference', picked.value, vscode.ConfigurationTarget.Global);
			}
		}),
		vscode.commands.registerCommand('googleAcp.removeApiKey', async () => {
			try {
				await agent.removeApiKey();
			} catch (error) {
				reportFailure("could not remove the API key", error);
			}
		}),
		vscode.commands.registerCommand('googleAcp.restart', async () => {
			try {
				await provider.restart();
				void vscode.window.showInformationMessage("Google ACP: the agent was restarted.");
			} catch (error) {
				reportFailure("could not restart the agent", error);
			}
		}),
		vscode.commands.registerCommand('googleAcp.showAccount', () => provider.showAccount()),
	);

	log('Google ACP activated.');
	void startUp(context, agent, provider);
}

export async function deactivate(): Promise<void> {
	try {
		await activeProvider?.closeAllSessions();
	} catch {
		// Clean exit; process termination follows either way.
	}
	killAllChildren();
}

/**
 * Nothing is downloaded or started on behalf of someone who never asked for it:
 * when the ACP server is on the machine the models are published as usual,
 * otherwise the user gets a single offer to set it up.
 */
async function startUp(context: vscode.ExtensionContext, agent: AgentClient, provider: GoogleAcpProvider): Promise<void> {
	if (await agent.isInstalled()) {
		void showNoticeOnce(context);
		await provider.publishModels();
		return;
	}

	if (context.globalState.get<boolean>(SETUP_OFFERED_KEY)) {
		return;
	}
	await context.globalState.update(SETUP_OFFERED_KEY, true);

	if (agent.usesDownloadedServer) {
		const choice = await vscode.window.showInformationMessage(
			"Google ACP needs Google's Antigravity ACP server, which is downloaded once (about 125 MB) from dl.google.com before Antigravity models appear in Copilot Chat.",
			"Set Up",
			"Not Now",
		);
		if (choice === "Set Up") {
			await vscode.commands.executeCommand('googleAcp.setUp');
		}
		return;
	}

	const spec = agent.launchSpec;
	const choice = await vscode.window.showInformationMessage(
		`Google ACP needs the "${spec.command}" program, which was not found. Install it (see the README), or point googleAcp.agent.command at it.`,
		"Open README",
	);
	if (choice === "Open README") {
		await vscode.env.openExternal(vscode.Uri.parse(String(context.extension.packageJSON.homepage)));
	}
}

/** Antigravity's terms disallow driving the service through third-party tools; say so once, before the first sign-in. */
async function showNoticeOnce(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(NOTICE_SHOWN_KEY)) {
		return;
	}
	await context.globalState.update(NOTICE_SHOWN_KEY, true);
	void vscode.window.showWarningMessage(
		"Google ACP runs Google's own Antigravity server and keeps sign-in inside it. Google's Antigravity terms do not allow third-party software that reuses its credentials, so use it for your own account and your own work, never as a shared service.",
	);
}
