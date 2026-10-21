/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import type { Log } from './logging';

/**
 * Google's official Antigravity ACP server, as listed in the ACP registry
 * (id `antigravity-acp`, https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).
 * Bump the version and the URLs together when the registry moves on.
 */
export const SERVER_VERSION = '1.4.1';

const DOWNLOAD_ROOT = 'https://dl.google.com/agy-extensions/releases';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const MARKER_FILE = 'installed-version';

export interface ServerArchive {
	readonly url: string;
	/** The program inside the archive. */
	readonly command: string;
	readonly args: readonly string[];
}

/** The registry entry for each platform this extension supports. */
export function serverArchiveFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ServerArchive | undefined {
	const version = SERVER_VERSION;
	const key = `${platform}-${arch}`;
	switch (key) {
		case 'win32-x64':
			return { url: `${DOWNLOAD_ROOT}/windows/agy-acp-server-${version}-windows-x86_64.zip`, command: 'agy_acp_server.exe', args: [] };
		case 'win32-arm64':
			return { url: `${DOWNLOAD_ROOT}/windows/agy-acp-server-${version}-windows-arm64.zip`, command: 'agy_acp_server.exe', args: [] };
		case 'darwin-arm64':
			return { url: `${DOWNLOAD_ROOT}/macos/agy-acp-server-${version}-darwin-arm64.zip`, command: 'agy_acp_server.par', args: [] };
		case 'darwin-x64':
			return { url: `${DOWNLOAD_ROOT}/macos/agy-acp-server-${version}-darwin-x86_64.zip`, command: 'agy_acp_server.par', args: [] };
		case 'linux-x64':
			return { url: `${DOWNLOAD_ROOT}/linux/agy-acp-server-${version}-linux-x86_64.zip`, command: 'agy_acp_server.par', args: ['--uid='] };
		case 'linux-arm64':
			return { url: `${DOWNLOAD_ROOT}/linux/agy-acp-server-${version}-linux-arm64.zip`, command: 'agy_acp_server.par', args: ['--uid='] };
		default:
			return undefined;
	}
}

export interface InstalledServer {
	readonly file: string;
	readonly args: readonly string[];
}

export type DownloadProgress = (received: number, total: number | undefined) => void;

/**
 * Keeps Google's Antigravity ACP server in the extension's global storage, one
 * folder per version. Nothing is downloaded unless {@link install} is called,
 * which only happens after the user asked for it.
 */
export class ServerInstaller {

	constructor(
		private readonly root: string,
		private readonly log: Log,
		private readonly archive: ServerArchive | null = serverArchiveFor() ?? null,
	) { }

	get versionDirectory(): string {
		return path.join(this.root, `v${SERVER_VERSION}`);
	}

	/** The server program when the current version is fully installed, else `undefined`. */
	async find(): Promise<InstalledServer | undefined> {
		if (!this.archive) {
			return undefined;
		}
		try {
			const marker = await fs.promises.readFile(path.join(this.versionDirectory, MARKER_FILE), 'utf8');
			if (marker.trim() !== SERVER_VERSION) {
				return undefined;
			}
			const file = path.join(this.versionDirectory, this.archive.command);
			await fs.promises.access(file);
			return { file, args: this.archive.args };
		} catch {
			return undefined;
		}
	}

	/** Downloads and unpacks the server unless the current version is already there. */
	async install(onProgress?: DownloadProgress): Promise<InstalledServer> {
		const existing = await this.find();
		if (existing) {
			return existing;
		}
		const archive = this.archive;
		if (!archive) {
			throw new Error(`Google publishes no Antigravity ACP server for ${process.platform}-${process.arch}.`);
		}

		await fs.promises.mkdir(this.root, { recursive: true });
		// A folder of its own per attempt, so two windows installing at once never share files.
		const work = await fs.promises.mkdtemp(path.join(this.root, `install-${process.pid}-`));
		try {
			const zip = path.join(work, 'server.zip');
			this.log(`Downloading the Antigravity ACP server ${SERVER_VERSION} from ${archive.url}`);
			await download(archive.url, zip, onProgress);

			const unpacked = path.join(work, 'unpacked');
			await fs.promises.mkdir(unpacked);
			await extractZip(zip, unpacked);

			const program = path.join(unpacked, archive.command);
			await fs.promises.access(program).catch(() => {
				throw new Error(`The downloaded archive does not contain ${archive.command}.`);
			});
			if (process.platform !== 'win32') {
				await fs.promises.chmod(program, 0o755);
			}
			// Written last: its presence is what marks the install as complete.
			await fs.promises.writeFile(path.join(unpacked, MARKER_FILE), SERVER_VERSION, 'utf8');

			if (!await this.find()) {
				await fs.promises.rm(this.versionDirectory, { recursive: true, force: true });
				await fs.promises.rename(unpacked, this.versionDirectory);
			}
			this.log(`Installed the Antigravity ACP server ${SERVER_VERSION} in ${this.versionDirectory}`);
		} finally {
			await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
		}

		await this.pruneOthers();
		const installed = await this.find();
		if (!installed) {
			throw new Error("The Antigravity ACP server was unpacked but could not be found afterwards.");
		}
		return installed;
	}

	/** Removes earlier versions and abandoned install attempts. Best effort. */
	private async pruneOthers(): Promise<void> {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.root);
		} catch {
			return;
		}
		const keep = path.basename(this.versionDirectory);
		for (const name of names) {
			if (name === keep || (name.startsWith('install-') && name.includes(`-${process.pid}-`))) {
				continue;
			}
			if (!/^v\d/.test(name)) {
				continue;
			}
			await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true }).catch(error => {
				// A window still running an older version may hold its files open.
				this.log(`Could not remove the old server files "${name}": ${error instanceof Error ? error.message : String(error)}`, 'warn');
			});
		}
	}
}

/** Downloads over HTTPS only, following a few redirects, and checks the size when the server states it. */
function download(url: string, destination: string, onProgress?: DownloadProgress, redirects = 0): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (!url.startsWith('https://')) {
			reject(new Error(`Refusing to download from a non-HTTPS address: ${url}`));
			return;
		}
		const request = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, response => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirects >= MAX_REDIRECTS) {
					reject(new Error("Too many redirects while downloading the Antigravity ACP server."));
					return;
				}
				download(new URL(response.headers.location, url).toString(), destination, onProgress, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`Downloading the Antigravity ACP server failed with HTTP ${status}.`));
				return;
			}

			const total = Number(response.headers['content-length']) || undefined;
			let received = 0;
			const file = fs.createWriteStream(destination);
			response.on('data', (chunk: Buffer) => {
				received += chunk.length;
				onProgress?.(received, total);
			});
			response.on('error', reject);
			file.on('error', reject);
			file.on('finish', () => {
				if (total !== undefined && received !== total) {
					reject(new Error(`The download stopped early (${received} of ${total} bytes).`));
				} else {
					resolve();
				}
			});
			response.pipe(file);
		});
		request.on('timeout', () => request.destroy(new Error("The download timed out.")));
		request.on('error', reject);
	});
}

/** Unpacks a zip with the system tool: `tar` (bsdtar) on Windows and macOS, `unzip` elsewhere. */
function extractZip(zip: string, destination: string): Promise<void> {
	const [command, args] = process.platform === 'linux'
		? ['unzip', ['-q', '-o', zip, '-d', destination]]
		: ['tar', ['-xf', zip, '-C', destination]];
	return new Promise<void>((resolve, reject) => {
		cp.execFile(command, args, { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true }, error => {
			if (!error) {
				resolve();
			} else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new Error(`Could not unpack the download because "${command}" is not installed.`));
			} else {
				reject(new Error(`Could not unpack the download: ${error.message}`));
			}
		});
	});
}
