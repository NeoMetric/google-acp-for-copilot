/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, readHead, stripFrontmatter } from './skills';

/** The kinds of Copilot customization file this extension passes on to the agent. */
export type CustomKind = 'instructions' | 'agent' | 'prompt';

/** A customization file found on disk that the agent reads on demand. */
export interface CustomFile {
	readonly kind: CustomKind;
	readonly name: string;
	readonly description: string;
	/** Absolute path of the file. */
	readonly file: string;
	/** For instruction files: the glob the file applies to, when it has one. */
	readonly applyTo?: string;
}

/** An instruction file that applies to every file, so its text goes straight into the prompt. */
export interface AlwaysOnInstructions {
	readonly source: string;
	readonly text: string;
}

export interface Customizations {
	readonly alwaysOn: AlwaysOnInstructions[];
	readonly files: CustomFile[];
}

const INSTRUCTIONS_READ_BYTES = 64 * 1024;

/** Where else to look besides the default folders. */
export interface CustomizationSources {
	/** The `chat.*FilesLocations` settings, per kind: folder (absolute, `~/`, or relative to each workspace folder) to enabled. */
	readonly locations?: Partial<Record<CustomKind, Record<string, boolean> | undefined>>;
	/** The active VS Code profile's `prompts` folder, which holds the user-level files of every kind. */
	readonly profilePromptsDir?: string;
}

const KINDS: ReadonlyArray<{ kind: CustomKind; suffix: string; userFolder: string; workspaceFolder: string }> = [
	{ kind: 'instructions', suffix: '.instructions.md', userFolder: '.copilot/instructions', workspaceFolder: '.github/instructions' },
	{ kind: 'agent', suffix: '.agent.md', userFolder: '.copilot/agents', workspaceFolder: '.github/agents' },
	{ kind: 'prompt', suffix: '.prompt.md', userFolder: '.copilot/prompts', workspaceFolder: '.github/prompts' },
];

/**
 * Reads the instruction, agent and prompt files Copilot would pick up: the
 * user's own and those of each workspace folder (empty when the workspace is
 * not trusted). Instruction files that apply to everything are returned with
 * their text; every other file is returned as a pointer for the agent to read
 * when it matters, so a large set of files does not fill the prompt.
 */
export async function discoverCustomizations(home: string, workspaceFolders: readonly string[], sources: CustomizationSources = {}): Promise<Customizations> {
	const alwaysOn: AlwaysOnInstructions[] = [];
	const files: CustomFile[] = [];

	for (const { kind, suffix, userFolder, workspaceFolder } of KINDS) {
		const candidates = [
			{ dir: path.join(home, ...userFolder.split('/')), label: `~/${userFolder}` },
			...workspaceFolders.map(root => ({ dir: path.join(root, ...workspaceFolder.split('/')), label: `${path.basename(root)}/${workspaceFolder}` })),
			...(sources.profilePromptsDir ? [{ dir: sources.profilePromptsDir, label: 'profile/prompts' }] : []),
		];
		for (const [location, enabled] of Object.entries(sources.locations?.[kind] ?? {})) {
			if (enabled !== true || !location.trim()) {
				continue;
			}
			const expanded = location.startsWith('~/') || location.startsWith('~\\') ? path.join(home, location.slice(2)) : location;
			for (const dir of path.isAbsolute(expanded) ? [expanded] : workspaceFolders.map(root => path.join(root, expanded))) {
				candidates.push({ dir, label: dir });
			}
		}

		const seen = new Set<string>();
		const folders = candidates.filter(({ dir }) => {
			const key = path.resolve(dir).toLowerCase();
			return !seen.has(key) && !!seen.add(key);
		});

		for (const { dir, label } of folders) {
			let entries: string[];
			try {
				entries = (await fs.promises.readdir(dir)).filter(name => name.endsWith(suffix)).sort();
			} catch {
				continue;
			}
			for (const entry of entries) {
				const file = path.join(dir, entry);
				const text = await readHead(file, INSTRUCTIONS_READ_BYTES);
				if (text === undefined) {
					continue;
				}
				const fields = parseFrontmatter(text);
				const name = entry.slice(0, -suffix.length);
				const applyTo = fields.applyTo?.trim() || undefined;

				if (kind === 'instructions' && appliesToEverything(applyTo)) {
					const body = stripFrontmatter(text);
					if (body.trim()) {
						alwaysOn.push({ source: `${label}/${entry}`, text: body });
					}
					continue;
				}
				files.push({ kind, name, description: (fields.description ?? '').replace(/\s+/g, ' ').trim(), file, applyTo });
			}
		}
	}

	return { alwaysOn, files };
}

function appliesToEverything(applyTo: string | undefined): boolean {
	return applyTo !== undefined && applyTo.split(',').some(pattern => ['**', '**/*'].includes(pattern.trim()));
}
