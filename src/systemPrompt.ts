/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Log } from './logging';
import { discoverCustomizations, type CustomFile, type CustomKind } from './customizations';
import { discoverSkills, readHead, skillRoots, type Skill } from './skills';

/** Room for the skills list, the same as Copilot's own `chat.copilot.skillCharBudget` default. */
export const SKILLS_CHAR_BUDGET = 30_000;
export const INSTRUCTIONS_CHAR_BUDGET = 20_000;

/** Instruction files are read from the top; anything past this is cut anyway. */
const INSTRUCTIONS_READ_BYTES = 64 * 1024;
const INSTRUCTION_FILES = ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md'];
/** Room for the pointers to instruction, agent and prompt files, which the agent reads on demand. */
export const CUSTOM_FILES_CHAR_BUDGET = 10_000;

export interface Instructions {
	/** Where the text came from, shown to the agent. */
	readonly source: string;
	readonly text: string;
}

export interface SessionPromptInput {
	readonly skills: readonly Skill[];
	readonly instructions: readonly Instructions[];
	/** Instruction, agent and prompt files the agent reads when they apply. */
	readonly customFiles?: readonly CustomFile[];
	/** The names of the tools Copilot offers the chat, as Copilot calls them. */
	readonly toolNames: readonly string[];
}

const INTRO = `You are running inside Visual Studio Code, as the model behind a chat in GitHub Copilot Chat. The tools of the MCP server named \`vscode\` are VS Code's own and act on the user's workspace.`;

const SKILLS_HEADER = `## Skills

A skill is a folder of instructions for one kind of task, described by its \`SKILL.md\`. When the task matches a skill below, read its \`SKILL.md\` with whichever of your tools reads files before you start, and follow it; paths inside it are relative to its folder. Skip skills that do not apply.
`;

const MEMORY_SECTION = `## Memory

The \`memory\` tool of the \`vscode\` MCP server keeps notes that last: \`/memories/\` for the user across workspaces and chats, \`/memories/repo/\` for this workspace, and \`/memories/session/\` for this chat. Nothing from it is loaded for you. When earlier context could help, \`view\` \`/memories/\` first and read what matches. Save a durable fact, such as a preference, a convention or a lesson, when the user asks or when it will clearly matter again, and keep entries short. This is the only memory to use.`;

/**
 * The text appended to the agent's own system prompt for one chat. Skills and
 * instructions come from files on disk and do not depend on which tools the
 * chat offers; the memory section names a tool, so it appears only when the
 * chat has that tool. The text depends on
 * nothing that changes from turn to turn, so it does not break prompt caching.
 */
export function buildSystemPromptAppend(input: SessionPromptInput): string | undefined {
	const tools = new Set(input.toolNames);
	const sections: string[] = [];

	const instructions = instructionsSection(input.instructions);
	if (instructions) {
		sections.push(instructions);
	}
	const skills = skillsSection(input.skills);
	if (skills) {
		sections.push(skills);
	}
	sections.push(...customFilesSections(input.customFiles ?? []));
	if (tools.has('memory')) {
		sections.push(MEMORY_SECTION);
	}

	return sections.length === 0 ? undefined : [INTRO, ...sections].join('\n\n');
}

function skillsSection(skills: readonly Skill[]): string | undefined {
	if (skills.length === 0) {
		return undefined;
	}

	const lines: string[] = [];
	let used = 0;
	for (const skill of skills) {
		const line = `- ${skill.name}: ${skill.description} (${skill.file})`;
		if (used + line.length + 1 > SKILLS_CHAR_BUDGET) {
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}

	const omitted = skills.length - lines.length;
	if (omitted > 0) {
		lines.push(`- … ${omitted} more skill${omitted === 1 ? '' : 's'} not listed`);
	}
	return `${SKILLS_HEADER}\n${lines.join('\n')}`;
}

const CUSTOM_SECTIONS: ReadonlyArray<{ kind: CustomKind; title: string; intro: string }> = [
	{ kind: 'instructions', title: 'Instruction files for specific files', intro: 'Before you work on files that match a pattern below, read that instruction file and follow it. A file with no pattern applies when its description fits the task.' },
	{ kind: 'agent', title: 'Custom agents', intro: 'When the user asks for one of these by name, read its file and follow it for that task.' },
	{ kind: 'prompt', title: 'Prompt files', intro: 'The user may refer to one of these by name, for example as `/name`. Read its file and carry it out.' },
];

function customFilesSections(files: readonly CustomFile[]): string[] {
	const sections: string[] = [];
	let remaining = CUSTOM_FILES_CHAR_BUDGET;

	for (const { kind, title, intro } of CUSTOM_SECTIONS) {
		const lines: string[] = [];
		let omitted = 0;
		for (const item of files.filter(candidate => candidate.kind === kind)) {
			const pattern = item.applyTo ? ` [applies to: ${item.applyTo}]` : '';
			const line = `- ${item.name}${pattern}${item.description ? `: ${item.description}` : ''} (${item.file})`;
			if (line.length + 1 > remaining) {
				omitted++;
				continue;
			}
			lines.push(line);
			remaining -= line.length + 1;
		}
		if (omitted > 0) {
			lines.push(`- … ${omitted} more not listed`);
		}
		if (lines.length > 0) {
			sections.push(`## ${title}\n\n${intro}\n\n${lines.join('\n')}`);
		}
	}
	return sections;
}

function instructionsSection(instructions: readonly Instructions[]): string | undefined {
	const parts: string[] = [];
	let remaining = INSTRUCTIONS_CHAR_BUDGET;

	for (const { source, text } of instructions) {
		const body = text.trim();
		if (!body || remaining <= 0) {
			continue;
		}
		const fitted = body.length > remaining ? `${body.slice(0, remaining)}\n… (cut)` : body;
		remaining -= fitted.length;
		parts.push(`## Instructions from ${source}\n\n${fitted}`);
	}

	return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** The instruction files the workspace folders carry, which Copilot would have put in its own prompt. */
export async function loadInstructions(workspaceFolders: readonly string[]): Promise<Instructions[]> {
	const found: Instructions[] = [];

	for (const folder of workspaceFolders) {
		for (const relative of INSTRUCTION_FILES) {
			const text = await readHead(path.join(folder, ...relative.split('/')), INSTRUCTIONS_READ_BYTES);
			if (text?.trim()) {
				found.push({ source: `${path.basename(folder)}/${relative}`, text });
			}
		}
	}
	return found;
}

/**
 * Builds what to append for a new chat session from the skills and
 * instruction files on disk, honouring the same settings Copilot does. An
 * untrusted workspace contributes nothing, since its files could carry
 * instructions aimed at the agent.
 */
export function createSessionPrompt(log: Log, profilePromptsDir?: string): (tools: readonly vscode.LanguageModelChatTool[]) => Promise<string | undefined> {
	return async tools => {
		const folders = vscode.workspace.isTrusted ? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath) : [];
		const chat = vscode.workspace.getConfiguration('chat');

		const skills = chat.get<boolean>('useAgentSkills', true)
			? await discoverSkills(skillRoots({
				home: os.homedir(),
				workspaceFolders: folders,
				locations: chat.get<Record<string, boolean>>('agentSkillsLocations'),
			}))
			: [];
		const custom = await discoverCustomizations(os.homedir(), folders, {
			profilePromptsDir,
			locations: {
				instructions: chat.get<Record<string, boolean>>('instructionsFilesLocations'),
				agent: chat.get<Record<string, boolean>>('agentFilesLocations'),
				prompt: chat.get<Record<string, boolean>>('promptFilesLocations'),
			},
		});
		const instructions = [...await loadInstructions(folders), ...custom.alwaysOn];

		const append = buildSystemPromptAppend({ skills, instructions, customFiles: custom.files, toolNames: tools.map(tool => tool.name) });
		const toolNames = tools.map(tool => tool.name);
		const hasRead = toolNames.includes('read_file');
		log(`Session prompt: ${skills.length} skill(s), ${instructions.length} instruction file(s), ${custom.files.length} on-demand file(s), ${append?.length ?? 0} character(s); workspace trusted: ${vscode.workspace.isTrusted}, folders: ${folders.join(', ') || 'none'}; ${toolNames.length} tool(s), read_file: ${hasRead}, memory: ${toolNames.includes('memory')}${hasRead ? '' : ` (tools: ${toolNames.join(', ') || 'none'})`}.`);
		return append;
	};
}
