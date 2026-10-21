/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertShellSafe, launchSpecFor, resolveCommand } from '../../src/launch';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-acp-launch-'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

describe('launchSpecFor', () => {
	it('uses the Antigravity server by default', () => {
		expect(launchSpecFor()).toEqual({ command: 'agy_acp_server', args: [] });
	});

	it('lets settings replace the command and the arguments', () => {
		expect(launchSpecFor({ command: ' /opt/agy ', args: ['--debug'] })).toEqual({ command: '/opt/agy', args: ['--debug'] });
		expect(launchSpecFor({ command: '', args: [] })).toEqual({ command: 'agy_acp_server', args: [] });
		expect(launchSpecFor({ args: ['--debug'] }).args).toEqual(['--debug']);
	});
});

describe('resolveCommand', () => {
	it('finds a program on PATH', () => {
		const file = path.join(temp, 'tool');
		fs.writeFileSync(file, '');

		expect(resolveCommand('tool', { PATH: temp }, 'linux')).toEqual({ file, viaShell: false });
		expect(resolveCommand('missing', { PATH: temp }, 'linux')).toBeUndefined();
	});

	it('takes a path as given', () => {
		const file = path.join(temp, 'tool');
		fs.writeFileSync(file, '');

		expect(resolveCommand(file, { PATH: '' }, 'linux')?.file).toBe(file);
	});

	it('applies PATHEXT on Windows and flags .cmd shims as needing a shell', () => {
		const shim = path.join(temp, 'agy.cmd');
		const exe = path.join(temp, 'agy-acp.exe');
		fs.writeFileSync(shim, '');
		fs.writeFileSync(exe, '');
		const env = { PATH: temp, PATHEXT: '.exe;.cmd' };

		expect(resolveCommand('agy', env, 'win32')).toEqual({ file: shim, viaShell: true });
		expect(resolveCommand('agy-acp', env, 'win32')).toEqual({ file: exe, viaShell: false });
	});
});

describe('assertShellSafe', () => {
	it('allows plain flags and paths', () => {
		expect(() => assertShellSafe(['--acp', '--model=gemini-3', 'C:\\tools\\agy.js'])).not.toThrow();
	});

	it('refuses anything cmd.exe would interpret', () => {
		for (const argument of ['a & b', '"quoted"', '%PATH%', 'a|b', '^x']) {
			expect(() => assertShellSafe([argument])).toThrow('cannot be passed');
		}
	});
});
