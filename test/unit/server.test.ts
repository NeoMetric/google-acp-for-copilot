/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION, ServerInstaller, serverArchiveFor } from '../../src/server';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-acp-server-'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

describe('serverArchiveFor', () => {
	it('names the registry download for each supported platform', () => {
		expect(serverArchiveFor('win32', 'x64')).toEqual({
			url: `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-${SERVER_VERSION}-windows-x86_64.zip`,
			command: 'agy_acp_server.exe',
			args: [],
		});
		expect(serverArchiveFor('darwin', 'arm64')?.url).toContain('/macos/agy-acp-server-');
		expect(serverArchiveFor('linux', 'x64')?.args).toEqual(['--uid=']);
		expect(serverArchiveFor('linux', 'arm64')?.url).toContain('linux-arm64.zip');
	});

	it('serves HTTPS downloads from Google only', () => {
		for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
			expect(serverArchiveFor(platform, arch)?.url).toMatch(/^https:\/\/dl\.google\.com\/agy-extensions\/releases\//);
		}
	});

	it('is undefined on platforms without a build', () => {
		expect(serverArchiveFor('freebsd', 'x64')).toBeUndefined();
		expect(serverArchiveFor('win32', 'ia32')).toBeUndefined();
	});
});

describe('ServerInstaller', () => {
	const archive = { url: 'https://dl.google.com/x.zip', command: 'server.exe', args: ['--flag'] };

	function installFake(root: string, version = SERVER_VERSION): string {
		const directory = path.join(root, `v${SERVER_VERSION}`);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'server.exe'), '');
		fs.writeFileSync(path.join(directory, 'installed-version'), version);
		return path.join(directory, 'server.exe');
	}

	it('finds nothing until the install is marked complete', async () => {
		const installer = new ServerInstaller(temp, vi.fn(), archive);
		expect(await installer.find()).toBeUndefined();

		const directory = path.join(temp, `v${SERVER_VERSION}`);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'server.exe'), '');
		expect(await installer.find()).toBeUndefined();
	});

	it('finds a complete install, with the arguments the registry gives', async () => {
		const file = installFake(temp);

		expect(await new ServerInstaller(temp, vi.fn(), archive).find()).toEqual({ file, args: ['--flag'] });
	});

	it('ignores an install marked with another version', async () => {
		installFake(temp, '0.0.1');

		expect(await new ServerInstaller(temp, vi.fn(), archive).find()).toBeUndefined();
	});

	it('does not download when the current version is installed', async () => {
		const file = installFake(temp);
		const installer = new ServerInstaller(temp, vi.fn(), { ...archive, url: 'http://not-used.example/x.zip' });

		await expect(installer.install()).resolves.toEqual({ file, args: ['--flag'] });
	});

	it('refuses a download that is not HTTPS, and leaves nothing behind', async () => {
		const installer = new ServerInstaller(temp, vi.fn(), { ...archive, url: 'http://dl.google.com/x.zip' });

		await expect(installer.install()).rejects.toThrow('non-HTTPS');
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	it('explains when there is no build for the platform', async () => {
		const installer = new ServerInstaller(temp, vi.fn(), null);

		expect(await installer.find()).toBeUndefined();
		await expect(installer.install()).rejects.toThrow('publishes no Antigravity ACP server');
	});
});
