/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { AcpConfigOption } from '../../src/agent';
import {
	acpModelValue, contextWindowOf, familyOf, DEFAULT_CONTEXT_WINDOW, EXTENDED_CONTEXT_WINDOW, effortLevelsOf, effortOf, findEffortOption, findModelOption,
	flattenChoices, MAX_OUTPUT_TOKENS, toModelVariants,
} from '../../src/models';

const modelOption: AcpConfigOption = {
	id: 'model',
	name: 'Model',
	category: 'model',
	type: 'select',
	options: [
		{ value: 'default', name: 'Default' },
		{ group: 'Older', options: [{ value: 'claude-opus-4-6', name: 'Opus 4.6' }] },
	],
};

const effortOption: AcpConfigOption = {
	id: 'effort',
	name: 'Effort',
	category: 'thought_level',
	type: 'select',
	options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }],
};

describe('config options', () => {
	it('finds the model and effort options', () => {
		expect(findModelOption([effortOption, modelOption])).toBe(modelOption);
		expect(findEffortOption([modelOption, effortOption])).toBe(effortOption);
		expect(findModelOption([effortOption])).toBeUndefined();
	});

	it('falls back to the option id and category', () => {
		const bare: AcpConfigOption = { id: 'model', name: 'M', type: 'select', options: [] };
		expect(findModelOption([bare])).toBe(bare);
		const byCategory: AcpConfigOption = { id: 'something', name: 'S', category: 'thought_level', type: 'select', options: [] };
		expect(findEffortOption([byCategory])).toBe(byCategory);
	});

	it('flattens grouped choices', () => {
		expect(flattenChoices(modelOption.options!).map(choice => choice.value)).toEqual(['default', 'claude-opus-4-6']);
	});

	it('lists the effort levels, or none', () => {
		expect(effortLevelsOf([effortOption])).toEqual(['default', 'high', 'xhigh']);
		expect(effortLevelsOf([modelOption])).toEqual([]);
	});
});

describe('contextWindowOf', () => {
	it.each([
		['default', EXTENDED_CONTEXT_WINDOW],
		['gemini-3.7-flash-high', EXTENDED_CONTEXT_WINDOW],
		['gemini-pro-agent Gemini Pro', EXTENDED_CONTEXT_WINDOW],
		['something-unknown', EXTENDED_CONTEXT_WINDOW],
		['claude-opus-4-6', DEFAULT_CONTEXT_WINDOW],
		['claude-sonnet-4-6 Claude Sonnet', DEFAULT_CONTEXT_WINDOW],
		['gpt-oss-120b', DEFAULT_CONTEXT_WINDOW],
	])('%s -> %i', (model, expected) => {
		expect(contextWindowOf(model)).toBe(expected);
	});
});

describe('toModelVariants', () => {
	const choices = flattenChoices(modelOption.options!);

	it('publishes every model twice: for chat and for the Copilot CLI agent', () => {
		const models = toModelVariants(choices, ['default', 'high']);

		expect(models.map(model => model.id)).toEqual(['default', 'default::agent', 'claude-opus-4-6', 'claude-opus-4-6::agent']);
		const agentVariant = models[1] as vscode.LanguageModelChatInformation & { targetChatSessionType?: string };
		expect(agentVariant.targetChatSessionType).toBe('copilotcli');
		expect((models[0] as { targetChatSessionType?: string }).targetChatSessionType).toBeUndefined();
	});

	it('sizes the input window so that input plus output is the context window', () => {
		const [extended, , standard] = toModelVariants(choices, []);

		expect(extended.maxInputTokens + extended.maxOutputTokens).toBe(EXTENDED_CONTEXT_WINDOW);
		expect(standard.maxInputTokens + standard.maxOutputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(extended.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
	});

	it('offers the thinking effort only when the agent reports levels', () => {
		const withEffort = toModelVariants(choices, ['default', 'xhigh'])[0] as { configurationSchema?: { properties: Record<string, { enum: string[]; enumItemLabels: string[]; default: string }> } };
		const property = withEffort.configurationSchema!.properties.reasoningEffort;
		expect(property.enum).toEqual(['default', 'xhigh']);
		expect(property.enumItemLabels).toEqual(['Default', 'Extra High']);
		expect(property.default).toBe('default');

		expect((toModelVariants(choices, [])[0] as { configurationSchema?: unknown }).configurationSchema).toBeUndefined();
	});

	it('declares tool calling and image input', () => {
		expect(toModelVariants(choices, [])[0].capabilities).toEqual({ toolCalling: true, imageInput: true });
	});
});

describe('acpModelValue', () => {
	it('strips the agent suffix and nothing else', () => {
		expect(acpModelValue('opus::agent')).toBe('opus');
		expect(acpModelValue('opus')).toBe('opus');
	});
});

describe('effortOf', () => {
	const options = (extra: object) => ({ toolMode: 1, ...extra }) as unknown as vscode.ProvideLanguageModelChatResponseOptions;

	it('prefers the model configuration over the legacy model options', () => {
		expect(effortOf(options({ modelConfiguration: { reasoningEffort: 'high' }, modelOptions: { reasoningEffort: 'low' } }))).toBe('high');
		expect(effortOf(options({ modelOptions: { reasoningEffort: 'low' } }))).toBe('low');
	});

	it('ignores missing or empty values', () => {
		expect(effortOf(options({}))).toBeUndefined();
		expect(effortOf(options({ modelConfiguration: { reasoningEffort: '' } }))).toBeUndefined();
	});
});

describe('familyOf', () => {
	it('groups models by who made them', () => {
		expect(familyOf('gemini-3.7-flash-high')).toBe('gemini');
		expect(familyOf('claude-sonnet-4-6')).toBe('claude');
		expect(familyOf('gpt-oss-120b')).toBe('gpt-oss');
		expect(familyOf('default Default')).toBe('gemini');
	});
});
