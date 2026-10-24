/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The kinds of Copilot customization file this extension passes on to the agent. */
export type CustomKind = 'instructions' | 'prompt';

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

export interface Customizations {
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
	{ kind: 'prompt', suffix: '.prompt.md', userFolder: '.copilot/prompts', workspaceFolder: '.github/prompts' },
];

/**
 * Reads the instruction and prompt files Copilot would pick up: the user's own
 * and those of each workspace folder (empty when the workspace is not
 * trusted). Each is returned as a pointer for the agent to read when it
 * matters, so a large set of files does not fill the prompt.
 *
 * Skills and custom agents are not read: Copilot lists both itself, and its
 * own list reaches the agent untouched.
 */
export async function discoverCustomizations(home: string, workspaceFolders: readonly string[], sources: CustomizationSources = {}): Promise<Customizations> {
	const files: CustomFile[] = [];

	for (const { kind, suffix, userFolder, workspaceFolder } of KINDS) {
		const candidates = [
			path.join(home, ...userFolder.split('/')),
			...workspaceFolders.map(root => path.join(root, ...workspaceFolder.split('/'))),
			...(sources.profilePromptsDir ? [sources.profilePromptsDir] : []),
		];
		for (const [location, enabled] of Object.entries(sources.locations?.[kind] ?? {})) {
			if (enabled !== true || !location.trim()) {
				continue;
			}
			const expanded = location.startsWith('~/') || location.startsWith('~\\') ? path.join(home, location.slice(2)) : location;
			for (const dir of path.isAbsolute(expanded) ? [expanded] : workspaceFolders.map(root => path.join(root, expanded))) {
				candidates.push(dir);
			}
		}

		const seen = new Set<string>();
		const folders = candidates.filter(dir => {
			const key = path.resolve(dir).toLowerCase();
			return !seen.has(key) && !!seen.add(key);
		});

		for (const dir of folders) {
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
				files.push({ kind, name, description: (fields.description ?? '').replace(/\s+/g, ' ').trim(), file, applyTo });
			}
		}
	}

	return { files };
}

/** The first `limit` bytes of a file as text, or `undefined` when it cannot be read. */
export async function readHead(file: string, limit: number): Promise<string | undefined> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, 'r');
		const buffer = Buffer.alloc(limit);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString('utf8', 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

/**
 * Reads the `key: value` lines of a `---` block at the top of a file. This is
 * the small subset of YAML that customization files use: plain or quoted values
 * on one line, and `>` or `|` block values that continue on indented lines.
 */
export function parseFrontmatter(text: string): Record<string, string> {
	const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!block) {
		return {};
	}

	const fields: Record<string, string> = {};
	const lines = block[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[index]);
		if (!line) {
			continue;
		}
		let value = line[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const continued: string[] = [];
			while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
				continued.push(lines[++index].trim());
			}
			value = continued.join(' ');
		}
		fields[line[1]] = unquote(value);
	}
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}
