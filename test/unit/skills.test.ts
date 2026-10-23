/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills, parseFrontmatter, skillRoots } from '../../src/skills';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-acp-skills-'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

/** Writes `<root>/<folder>/SKILL.md` and returns the root, ready to be searched. */
function writeSkill(root: string, folder: string, frontmatter: string): string {
	const directory = path.join(temp, root, folder);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\nBody.\n`);
	return path.join(temp, root);
}

describe('parseFrontmatter', () => {
	it('reads plain, double quoted and single quoted values', () => {
		expect(parseFrontmatter('---\nname: plain\ndescription: "say \\"hi\\" \\\\ ok"\nother: \'it\'\'s\'\n---\nbody')).toEqual({
			name: 'plain',
			description: 'say "hi" \\ ok',
			other: "it's",
		});
	});

	it('keeps colons and dashes inside a value', () => {
		expect(parseFrontmatter('---\ndescription: **WORKFLOW** — USE FOR: a, b. DO NOT USE FOR: c\n---')).toEqual({
			description: '**WORKFLOW** — USE FOR: a, b. DO NOT USE FOR: c',
		});
	});

	it('joins block values that continue on indented lines', () => {
		expect(parseFrontmatter('---\ndescription: >-\n  first line\n  second line\nname: next\n---')).toEqual({
			description: 'first line second line',
			name: 'next',
		});
	});

	it('copes with CRLF line endings and a byte order mark', () => {
		expect(parseFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nbody')).toEqual({ name: 'a', description: 'b' });
	});

	it('is empty without a frontmatter block', () => {
		expect(parseFrontmatter('# Just a heading\nname: not frontmatter')).toEqual({});
		expect(parseFrontmatter('---\nname: never closed')).toEqual({});
	});
});

describe('skillRoots', () => {
	const home = path.join(os.tmpdir(), 'home');
	const workspace = path.join(os.tmpdir(), 'work');
	const user = ['.copilot', '.claude', '.agents'].map(folder => path.join(home, folder, 'skills'));
	const project = ['.github', '.claude', '.agents'].map(folder => path.join(workspace, folder, 'skills'));

	it('searches the user folders, then the workspace folders', () => {
		expect(skillRoots({ home, workspaceFolders: [workspace] })).toEqual([...user, ...project]);
	});

	it('searches only the user folders when no workspace may contribute', () => {
		expect(skillRoots({ home, workspaceFolders: [] })).toEqual(user);
	});

	it('drops a default folder the setting turns off', () => {
		const roots = skillRoots({ home, workspaceFolders: [workspace], locations: { '~/.claude/skills': false, '.agents/skills': false } });

		expect(roots).toEqual([user[0], user[2], project[0], project[1]]);
	});

	it('adds enabled folders last, resolving ~, absolute and relative paths', () => {
		const absolute = path.join(os.tmpdir(), 'shared-skills');
		const roots = skillRoots({
			home,
			workspaceFolders: [workspace],
			locations: { '~/my-skills': true, [absolute]: true, 'team/skills': true },
		});

		expect(roots.slice(6)).toEqual([path.join(home, 'my-skills'), absolute, path.join(workspace, 'team', 'skills')]);
	});

	it('lists a folder once even when the setting names a default again', () => {
		const roots = skillRoots({ home, workspaceFolders: [workspace], locations: { '~/.copilot/skills': true, '.github/skills': true } });

		expect(roots).toEqual([...user, ...project]);
	});

	it('ignores relative locations when there is no workspace', () => {
		expect(skillRoots({ home, workspaceFolders: [], locations: { 'team/skills': true } })).toEqual(user);
	});
});

describe('discoverSkills', () => {
	it('reads the name, description and file of each skill', async () => {
		const root = writeSkill('a', 'tidy', 'name: tidy-up\ndescription: Cleans things up');

		expect(await discoverSkills([root])).toEqual([
			{ name: 'tidy-up', description: 'Cleans things up', file: path.join(root, 'tidy', 'SKILL.md') },
		]);
	});

	it('falls back to the folder name', async () => {
		const root = writeSkill('a', 'tidy', 'description: Cleans things up');

		expect((await discoverSkills([root]))[0].name).toBe('tidy');
	});

	it('skips folders without a SKILL.md, without a description, and hidden ones', async () => {
		const root = writeSkill('a', 'no-description', 'name: x');
		writeSkill('a', '.hidden', 'description: nope');
		fs.mkdirSync(path.join(root, 'empty'));
		writeSkill('a', 'good', 'description: yes');

		expect((await discoverSkills([root])).map(skill => skill.name)).toEqual(['good']);
	});

	it('skips folders that do not exist', async () => {
		const root = writeSkill('a', 'good', 'description: yes');

		expect((await discoverSkills([path.join(temp, 'missing'), root])).map(skill => skill.name)).toEqual(['good']);
	});

	it('lets a later folder replace a skill of the same name', async () => {
		const user = writeSkill('user', 'review', 'description: from the user');
		const project = writeSkill('project', 'review', 'description: from the project');

		const skills = await discoverSkills([user, project]);

		expect(skills).toHaveLength(1);
		expect(skills[0].description).toBe('from the project');
	});

	it('returns the skills sorted by name', async () => {
		writeSkill('a', 'zebra', 'description: z');
		writeSkill('a', 'apple', 'description: a');
		writeSkill('b', 'mango', 'description: m');

		const skills = await discoverSkills([path.join(temp, 'a'), path.join(temp, 'b')]);

		expect(skills.map(skill => skill.name)).toEqual(['apple', 'mango', 'zebra']);
	});

	it('cuts a long description and collapses its whitespace', async () => {
		const root = writeSkill('a', 'long', `description: ${'word   '.repeat(400)}`);

		const [skill] = await discoverSkills([root]);

		expect(skill.description.length).toBeLessThanOrEqual(1000);
		expect(skill.description.endsWith('…')).toBe(true);
		expect(skill.description).not.toContain('  ');
	});
});
