/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { AcpConfigOption, AcpConfigOptionChoice, AcpConfigOptionGroup } from './agent';

const MODEL_CATEGORY = 'model';
const MODEL_DETAIL = 'Google ACP';
/** The model's own version is not known to the agent; the picker only needs a stable value. */
const MODEL_VERSION = '1';
export const MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Context windows by model family. Gemini models have a 1M-token window; the
 * Claude and GPT-OSS models that Antigravity also serves are smaller. The
 * agent only reports a window once a turn has run, so the picker relies on
 * these patterns; revisit them when Google ships new model families.
 */
const GEMINI_MODEL = /gemini/i;
const THIRD_PARTY_MODEL = /claude|sonnet|opus|haiku|gpt|oss/i;
/** The agent's config option id and ACP category for the thinking effort. */
export const EFFORT_CONFIG_ID = 'effort';
export const EFFORT_CATEGORY = 'thought_level';
/** The model configuration key the picker sends the chosen effort under. */
export const EFFORT_PROPERTY = 'reasoningEffort';
/** The model picker only shows a property in the toolbar when it is in this group. */
const EFFORT_GROUP = 'navigation';

/**
 * The Copilot CLI agent's chat session type. The chat model picker only lists
 * models that name the current session type, so every model is also published
 * with this target under a separate id (see {@link toModelVariants}).
 */
export const COPILOT_CLI_SESSION_TYPE = 'copilotcli';
export const AGENT_MODEL_ID_SUFFIX = '::agent';

export function findModelOption(configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.category === MODEL_CATEGORY && option.type === 'select')
		?? configOptions.find(option => option.id === MODEL_CATEGORY && option.type === 'select');
}

export function findEffortOption(configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
	return configOptions.find(option => option.id === EFFORT_CONFIG_ID)
		?? configOptions.find(option => option.category === EFFORT_CATEGORY && option.type === 'select');
}

/** The effort values the agent accepts for the model it reported them for. */
export function effortLevelsOf(configOptions: readonly AcpConfigOption[]): string[] {
	const option = findEffortOption(configOptions);
	if (!option || option.type !== 'select') {
		return [];
	}
	return flattenChoices(option.options ?? []).map(choice => choice.value);
}

/** The effort the model picker sent with this request, if any. */
export function effortOf(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
	const configuration = (options as unknown as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
	const configured = configuration?.[EFFORT_PROPERTY];
	if (typeof configured === 'string' && configured.length > 0) {
		return configured;
	}
	const legacy = (options.modelOptions as Record<string, unknown> | undefined)?.[EFFORT_PROPERTY];
	return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

export function effortLabel(value: string): string {
	switch (value) {
		case 'default': return "Default";
		case 'xhigh': return "Extra High";
		case 'max': return "Max";
		default: return value.charAt(0).toUpperCase() + value.slice(1);
	}
}

export function effortDescription(value: string): string {
	switch (value) {
		case 'default': return "Use the effort the agent picks for this model.";
		case 'low': return "Minimal reasoning for the fastest answers.";
		case 'medium': return "Balanced reasoning for everyday tasks.";
		case 'high': return "Deeper reasoning for involved tasks.";
		case 'xhigh': return "Extended reasoning for difficult tasks.";
		case 'max': return "Maximum reasoning; the slowest, most thorough choice.";
		default: return "Effort level reported by the agent.";
	}
}

export function flattenChoices(options: ReadonlyArray<AcpConfigOptionChoice | AcpConfigOptionGroup>): AcpConfigOptionChoice[] {
	const choices: AcpConfigOptionChoice[] = [];

	for (const entry of options) {
		if ('options' in entry) {
			for (const choice of entry.options) {
				choices.push(choice);
			}
		} else {
			choices.push(entry);
		}
	}

	return choices;
}

export function contextWindowOf(modelValue: string): number {
	return THIRD_PARTY_MODEL.test(modelValue) && !GEMINI_MODEL.test(modelValue)
		? DEFAULT_CONTEXT_WINDOW
		: EXTENDED_CONTEXT_WINDOW;
}

/** The model family the picker groups by, guessed from the model id. */
export function familyOf(modelValue: string): string {
	if (/claude|sonnet|opus|haiku/i.test(modelValue)) {
		return 'claude';
	}
	return /gpt|oss/i.test(modelValue) && !GEMINI_MODEL.test(modelValue) ? 'gpt-oss' : 'gemini';
}

export function toModelVariants(choices: readonly AcpConfigOptionChoice[], effortLevels: readonly string[]): vscode.LanguageModelChatInformation[] {
	const models: vscode.LanguageModelChatInformation[] = [];

	for (const choice of choices) {
		models.push(toModelInformation(choice, choice.value, effortLevels));
		// A copy aimed at the Copilot CLI agent: same model, distinct id. Without the
		// target the agent's picker filters the model out entirely.
		models.push(toModelInformation(choice, `${choice.value}${AGENT_MODEL_ID_SUFFIX}`, effortLevels, COPILOT_CLI_SESSION_TYPE));
	}

	return models;
}

export function toModelInformation(choice: AcpConfigOptionChoice, id: string, effortLevels: readonly string[], targetChatSessionType?: string): vscode.LanguageModelChatInformation {
	const info: vscode.LanguageModelChatInformation = {
		id,
		name: choice.name,
		family: familyOf(`${choice.value} ${choice.name}`),
		version: MODEL_VERSION,
		detail: MODEL_DETAIL,
		tooltip: choice.description ?? `Model "${choice.name}" served by the local Google agent.`,
		// The picker shows the sum as the window, so the input share excludes the output.
		maxInputTokens: contextWindowOf(`${choice.value} ${choice.name}`) - MAX_OUTPUT_TOKENS,
		maxOutputTokens: MAX_OUTPUT_TOKENS,
		capabilities: {
			toolCalling: true,
			imageInput: true,
		},
	};

	// Proposed API fields; VS Code reads both when building the picker and
	// ignores unknown properties otherwise.
	const configurable = info as unknown as { configurationSchema?: unknown; targetChatSessionType?: string };

	if (effortLevels.length > 0) {
		configurable.configurationSchema = {
			properties: {
				[EFFORT_PROPERTY]: {
					type: 'string',
					title: "Thinking Effort",
					description: "How much reasoning the model spends before it answers.",
					group: EFFORT_GROUP,
					enum: [...effortLevels],
					enumItemLabels: effortLevels.map(effortLabel),
					enumDescriptions: effortLevels.map(effortDescription),
					default: effortLevels.includes('default') ? 'default' : effortLevels[0],
				},
			},
		};
	}

	if (targetChatSessionType) {
		configurable.targetChatSessionType = targetChatSessionType;
	}

	return info;
}

/** Maps a provider model id back to the model value the ACP agent understands. */
export function acpModelValue(modelId: string): string {
	return modelId.endsWith(AGENT_MODEL_ID_SUFFIX)
		? modelId.slice(0, -AGENT_MODEL_ID_SUFFIX.length)
		: modelId;
}
