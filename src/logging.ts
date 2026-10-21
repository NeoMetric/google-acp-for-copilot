/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Writes one message to the output channel; the level defaults to `info`. */
export type Log = (message: string, level?: LogLevel) => void;

/**
 * Binds a log function to the output channel, prefixing every message with
 * the component that wrote it. The channel adds the timestamp and the level.
 */
export function scopedLog(output: vscode.LogOutputChannel, scope?: string): Log {
	return (message, level = 'info') => {
		output[level](scope ? `[${scope}] ${message}` : message);
	};
}

/** Guesses the severity of a line of foreign output, such as the agent's stderr or npm. */
export function levelOfLine(line: string): LogLevel {
	if (/\b(error|fatal|failed|exception)\b/i.test(line) || /^npm err/i.test(line)) {
		return 'error';
	}
	if (/\bwarn(ing)?\b/i.test(line)) {
		return 'warn';
	}
	return 'info';
}
