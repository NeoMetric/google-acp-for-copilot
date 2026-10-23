/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { levelOfLine } from '../../src/logging';

describe('levelOfLine', () => {
	it('takes the level of the agent harness from its own tag', () => {
		expect(levelOfLine('ERROR: logging before google.Init: I1023 16:32:23.507898 320016 proxy_server.py:106] Proxy extracted model from path')).toBe('info');
		expect(levelOfLine('ERROR: logging before google.Init: W1023 16:33:42.224923     918 executor.go:234] error executing cascade step')).toBe('warn');
		expect(levelOfLine('E1023 16:33:42.215311 918 errorreport.go:224] error executing cascade step')).toBe('error');
		expect(levelOfLine('F1023 16:33:42.215311 918 main.go:1] out of memory')).toBe('error');
	});

	it('guesses the level of ordinary output', () => {
		expect(levelOfLine('npm ERR! code ENOENT')).toBe('error');
		expect(levelOfLine('The agent failed to start')).toBe('error');
		expect(levelOfLine('deprecated warning: something')).toBe('warn');
		expect(levelOfLine('Downloading the server')).toBe('info');
	});
});
