/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LaunchSpec {
	/** The program as the user configured it, before it is looked up on PATH. */
	readonly command: string;
	readonly args: readonly string[];
}

export interface LaunchOverrides {
	readonly command?: string;
	readonly args?: readonly string[];
}

/** A program found on disk, and how to start it. */
export interface ResolvedCommand {
	readonly file: string;
	/** Windows `.cmd` and `.bat` shims (what `npm install -g` creates) cannot be started without a shell. */
	readonly viaShell: boolean;
}

/** Google's official Antigravity ACP server, listed in the ACP registry as `antigravity-acp`. */
const DEFAULT_COMMAND = 'agy_acp_server';

/** Arguments that are safe to hand to `cmd.exe` unquoted. */
const SHELL_SAFE_ARGUMENT = /^[\w@+=:,./\\-]+$/;

export function launchSpecFor(overrides: LaunchOverrides = {}): LaunchSpec {
	const command = overrides.command?.trim();
	if (command) {
		return { command, args: overrides.args ?? [] };
	}
	return { command: DEFAULT_COMMAND, args: overrides.args ?? [] };
}

/** Looks `command` up the way a shell would: a path as given, otherwise the PATH entries in order. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ResolvedCommand | undefined {
	const windows = platform === 'win32';
	const extensions = windows
		? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
		: [''];
	const hasPath = command.includes('/') || command.includes('\\');
	const directories = hasPath ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);

	for (const directory of directories) {
		const base = directory ? path.join(directory, command) : command;
		const candidates = windows && path.extname(base) === '' ? extensions.map(extension => base + extension) : [base];
		if (windows && path.extname(base) !== '') {
			candidates.push(...extensions.map(extension => base + extension));
		}
		for (const candidate of candidates) {
			if (isFile(candidate)) {
				return { file: candidate, viaShell: windows && /\.(cmd|bat)$/i.test(candidate) };
			}
		}
	}
	return undefined;
}

/** Checks the arguments of a program that will go through `cmd.exe`, where quoting cannot be trusted. */
export function assertShellSafe(args: readonly string[]): void {
	for (const argument of args) {
		if (!SHELL_SAFE_ARGUMENT.test(argument)) {
			throw new Error(`The argument "${argument}" cannot be passed to a .cmd launcher. Point googleAcp.agent.command at the .exe or .js entry point instead.`);
		}
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}
