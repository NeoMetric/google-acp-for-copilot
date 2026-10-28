/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long a POSIX process group gets to exit after SIGTERM before it is killed. */
const TERMINATE_GRACE_MS = 3_000;

/**
 * Every spawned agent process, so `deactivate` can take down processes that
 * outlived their owner.
 */
const children = new Set<number>();

export function trackChild(pid: number): void {
	children.add(pid);
}

export function untrackChild(pid: number): void {
	children.delete(pid);
}

/**
 * Kills a process and everything it spawned.
 *
 * On Windows a process tree can only be taken down with `taskkill /T`; on POSIX
 * the child is spawned as a process-group leader (`detached`), so signalling
 * the negated pid reaches its descendants too. The pid stays tracked until the
 * kill has finished, so a `deactivate` that races with it still cleans up.
 */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		await run('taskkill', ['/pid', String(pid), '/T', '/F']);
		children.delete(pid);
		return;
	}

	signalGroup(pid, 'SIGTERM');
	const deadline = Date.now() + TERMINATE_GRACE_MS;
	while (isAlive(pid) && Date.now() < deadline) {
		await new Promise<void>(resolve => setTimeout(resolve, 100));
	}
	if (isAlive(pid)) {
		signalGroup(pid, 'SIGKILL');
	}
	children.delete(pid);
}

/**
 * Synchronous variant of {@link killTree}, for shutdown paths that cannot wait
 * for the event loop: `deactivate` is followed by process exit.
 */
export function killTreeSync(pid: number): void {
	children.delete(pid);

	if (process.platform === 'win32') {
		try {
			execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
		} catch {
			// Already gone.
		}
		return;
	}

	signalGroup(pid, 'SIGKILL');
}

/**
 * Records the agent process of this extension host in `dir`, in a file named
 * after the host's pid, so a later host can find agents their owner left behind.
 */
export function recordAgent(dir: string, childPid: number): void {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ childPid }));
	} catch {
		// Cleanup of strays is best effort.
	}
}

export function forgetAgent(dir: string): void {
	try {
		rmSync(join(dir, `${process.pid}.json`), { force: true });
	} catch {
		// Nothing to forget.
	}
}

/** Kills agents whose owning extension host is gone; agents of live windows are left alone. */
export function killStrayAgents(dir: string): number[] {
	const killed: number[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return killed;
	}
	for (const name of names) {
		const owner = Number(name.replace(/\.json$/, ''));
		const file = join(dir, name);
		if (!Number.isInteger(owner) || owner === process.pid || isAlive(owner)) {
			continue;
		}
		try {
			const { childPid } = JSON.parse(readFileSync(file, 'utf8')) as { childPid?: number };
			if (typeof childPid === 'number' && isAlive(childPid)) {
				killTreeSync(childPid);
				killed.push(childPid);
			}
		} catch {
			// Unreadable record; drop it.
		}
		try {
			rmSync(file, { force: true });
		} catch {
			// Retried on the next start.
		}
	}
	return killed;
}

/** Picks the pids out of `pid,parentPid` lines whose parent no longer runs. */
export function parseOrphans(output: string, isRunning: (pid: number) => boolean = isAlive): number[] {
	const orphans: number[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line);
		if (match && !isRunning(Number(match[2]))) {
			orphans.push(Number(match[1]));
		}
	}
	return orphans;
}

/**
 * Windows only: kills processes running `exePath` whose parent is gone. A server that
 * spawns a copy of itself leaves that copy behind when it dies first, and `taskkill /T`
 * cannot find descendants of a process that no longer exists, so neither the registry
 * nor the tree kill reaches it. Matching on the full path keeps other builds' servers
 * (Insiders, other extensions) out of reach, and agents of live windows have a live parent.
 */
export async function killOrphanedServers(exePath: string): Promise<number[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	const escaped = exePath.replace(/'/g, "''");
	const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq '${escaped}' } | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }`;
	const output = await new Promise<string>(resolve => {
		execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (error, stdout) => resolve(error ? '' : stdout));
	});
	const orphans = parseOrphans(output).filter(pid => pid !== process.pid && !children.has(pid));
	for (const pid of orphans) {
		await killTree(pid);
	}
	return orphans;
}

/** Best-effort teardown of every process this extension started. */
export function killAllChildren(): void {
	for (const pid of [...children]) {
		killTreeSync(pid);
	}
}


/** Calls `onLine` for every non-blank line a stream produces. */
export function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
	let buffer = '';
	stream.setEncoding?.('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf('\n');
		while (index !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, '');
			buffer = buffer.slice(index + 1);
			if (line.trim().length > 0) {
				onLine(line);
			}
			index = buffer.indexOf('\n');
		}
	});
	stream.on('end', () => {
		if (buffer.trim().length > 0) {
			onLine(buffer);
		}
		buffer = '';
	});
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function run(file: string, args: readonly string[]): Promise<void> {
	return new Promise(resolve => {
		const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
		child.on('error', () => resolve());
		child.on('exit', () => resolve());
	});
}
