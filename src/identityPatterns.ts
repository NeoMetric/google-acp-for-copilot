/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copilot's personality and identity text, which the agent must not receive:
 * it has a name and a voice of its own. Each pattern removes one sentence (or
 * line) wherever it appears in the guidance; everything around it is kept,
 * since the rest of those messages is functional. The list is the same in
 * every ACP extension, and the wording comes from Copilot's prompts
 * (`copilotIdentity.tsx`, `safetyRules.tsx` and the agent prompt).
 *
 * The rules for the content the model may produce are removed here too: the
 * intro the extension writes carries them once (see `systemPrompt.ts`), so
 * stripping them keeps them from being paid for twice.
 */
export const IDENTITY_PATTERNS: readonly RegExp[] = [
	// The opening line of the agent prompt.
	/^[ \t]*You are an expert AI programming assistant[^\r\n]*(?:\r?\n|$)/gm,
	// `CopilotIdentityRules` and the inline chat variants.
	/When asked for your name, you must respond with "GitHub Copilot"\.?[ \t]*/g,
	/When asked about the model you are using, (?:you must )?state (?:that you are using [^\r\n]*?|"[^"\r\n]*")\.(?=\s|$)[ \t]*/g,
	// `GPT5CopilotIdentityRule` and `Gpt55CopilotIdentityRule`.
	/Your name is GitHub Copilot\.[ \t]*/g,
	// The identity of the Copilot SDK host.
	/You are an AI assistant using Copilot SDK in VS Code\.?[ \t]*/g,
	/When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code\.?[ \t]*/g,
	// `SafetyRules` and `LegacySafetyRules`: the persona line, not the content policy.
	/Keep your answers short and impersonal\.[ \t]*/g,
	// `SafetyRules` and `LegacySafetyRules`: the content policy, which the intro carries instead.
	/^[ \t]*Follow Microsoft content policies\.[ \t]*$/gm,
	/^[ \t]*Avoid content that violates copyrights\.[ \t]*$/gm,
	/^[ \t]*If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, violent, or completely irrelevant to software engineering, only respond with "Sorry, I can't assist with that\."[ \t]*$/gm,
	/^[ \t]*If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that\."[ \t]*$/gm,
	// The system message Copilot adds for Voice Mode; its instructions stay.
	/Voice Mode is active, and you are GitHub Copilot speaking directly to the user\.[ \t]*/g,
];

/** `text` without the identity sentences of Copilot. */
export function stripIdentity(text: string): string {
	let result = text;
	for (const pattern of IDENTITY_PATTERNS) {
		result = result.replace(pattern, '');
	}
	return result.replace(/[ \t]+$/gm, '');
}
