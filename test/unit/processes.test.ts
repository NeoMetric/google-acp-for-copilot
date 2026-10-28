import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAgent, killStrayAgents, parseOrphans, recordAgent } from '../../src/processes';

describe('orphan detection', () => {
	it('reports only processes whose parent is gone', () => {
		const output = '100,1\r\n200,2\n\nnoise\n300, 3\n';
		expect(parseOrphans(output, pid => pid === 2)).toEqual([100, 300]);
	});
});

describe('agent registry', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'agents-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('keeps the record of a live owner', () => {
		recordAgent(dir, 999_999);
		expect(killStrayAgents(dir)).toEqual([]);
		expect(existsSync(join(dir, `${process.pid}.json`))).toBe(true);
		forgetAgent(dir);
		expect(existsSync(join(dir, `${process.pid}.json`))).toBe(false);
	});

	it('drops the record of a dead owner whose agent is gone', () => {
		const file = join(dir, '2147483646.json');
		writeFileSync(file, JSON.stringify({ childPid: 2147483645 }));
		expect(killStrayAgents(dir)).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});
});
