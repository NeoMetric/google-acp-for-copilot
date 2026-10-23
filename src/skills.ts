/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/** A skill found on disk: a folder with a `SKILL.md` that says when to use it. */
export interface Skill {
	readonly name: string;
	readonly description: string;
	/** Absolute path of the skill's `SKILL.md`. */
	readonly file: string;
}

export interface SkillRootsInput {
	readonly home: string;
	/** Workspace folders whose own skills may be used; empty when the workspace is not trusted. */
	readonly workspaceFolders: readonly string[];
	/** The `chat.agentSkillsLocations` setting: a folder maps to whether it is searched. */
	readonly locations?: Readonly<Record<string, boolean>>;
}

/** The folders Copilot searches by default, which this extension searches too. */
const USER_SKILL_FOLDERS = ['.copilot/skills', '.claude/skills', '.agents/skills'];
const WORKSPACE_SKILL_FOLDERS = ['.github/skills', '.claude/skills', '.agents/skills'];

/**
 * Longest description kept, so one verbose skill cannot crowd out the others.
 * Generous, because the "use when" phrases that say when a skill applies often
 * come last.
 */
const MAX_DESCRIPTION_CHARACTERS = 1000;
/** The frontmatter sits at the top of `SKILL.md`; the rest of the file is not needed. */
const FRONTMATTER_READ_BYTES = 16 * 1024;

/**
 * The folders to search, in the order they are read. A skill found later
 * replaces one of the same name found earlier, so the closer a folder is to
 * the work, the more it wins: user folders, then workspace folders, then the
 * extra folders the user added.
 */
export function skillRoots(input: SkillRootsInput): string[] {
	const defaults = [
		...USER_SKILL_FOLDERS.map(folder => path.join(input.home, ...folder.split('/'))),
		...input.workspaceFolders.flatMap(root => WORKSPACE_SKILL_FOLDERS.map(folder => path.join(root, ...folder.split('/')))),
	];

	const disabled = new Set<string>();
	const added: string[] = [];
	for (const [location, enabled] of Object.entries(input.locations ?? {})) {
		for (const resolved of resolveLocation(location, input)) {
			if (enabled === false) {
				disabled.add(comparable(resolved));
			} else if (enabled === true) {
				added.push(resolved);
			}
		}
	}

	const seen = new Set<string>();
	return [...defaults, ...added].filter(root => {
		const key = comparable(root);
		if (disabled.has(key) || seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** A setting value is `~/…`, an absolute path, or relative to each workspace folder. */
function resolveLocation(location: string, input: SkillRootsInput): string[] {
	const trimmed = location.trim();
	if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return [path.resolve(input.home, trimmed.slice(2))];
	}
	if (path.isAbsolute(trimmed)) {
		return [path.resolve(trimmed)];
	}
	return trimmed ? input.workspaceFolders.map(root => path.resolve(root, trimmed)) : [];
}

function comparable(folder: string): string {
	const normalized = path.normalize(folder);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Reads every skill under the given folders; folders that do not exist are skipped. */
export async function discoverSkills(roots: readonly string[]): Promise<Skill[]> {
	const byName = new Map<string, Skill>();

	for (const root of roots) {
		let entries: string[];
		try {
			entries = (await fs.promises.readdir(root)).filter(name => !name.startsWith('.')).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			const skill = await readSkill(path.join(root, entry), entry);
			if (skill) {
				byName.set(skill.name, skill);
			}
		}
	}

	// A fixed order keeps the prompt identical from one session to the next.
	return [...byName.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function readSkill(directory: string, folderName: string): Promise<Skill | undefined> {
	const file = path.join(directory, 'SKILL.md');
	const head = await readHead(file);
	if (head === undefined) {
		return undefined;
	}

	const fields = parseFrontmatter(head);
	const description = collapse(fields.description ?? '');
	if (!description) {
		return undefined;
	}
	return {
		name: collapse(fields.name ?? '') || folderName,
		description: description.length > MAX_DESCRIPTION_CHARACTERS ? `${description.slice(0, MAX_DESCRIPTION_CHARACTERS - 1)}…` : description,
		file,
	};
}

/** The first `limit` bytes of a file as text, or `undefined` when it cannot be read. */
export async function readHead(file: string, limit = FRONTMATTER_READ_BYTES): Promise<string | undefined> {
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
 * the small subset of YAML that skills use: plain or quoted values on one
 * line, and `>` or `|` block values that continue on indented lines.
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

/** The text without its `---` block at the top, if it has one. */
export function stripFrontmatter(text: string): string {
	return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
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

function collapse(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}
