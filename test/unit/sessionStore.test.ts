/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { hashAll, isPrefixOf, mismatchOf, SavedSessionStore, toolsHashOf, type ReuseCheck, type SavedSession } from '../../src/sessionStore';

const check: ReuseCheck = { cwd: '/work', toolsHash: toolsHashOf(['a', 'b']), guidanceHash: 'g1' };

function saved(key: string, history: string[], overrides: Partial<SavedSession> = {}): SavedSession {
	return { key, sessionId: `s-${key}`, cwd: '/work', history: hashAll(history), toolsHash: check.toolsHash, guidanceHash: check.guidanceHash, promptHash: 'p', savedAt: 1, ...overrides };
}

describe('toolsHashOf', () => {
	it('ignores the order of the tools', () => {
		expect(toolsHashOf(['b', 'a'])).toBe(toolsHashOf(['a', 'b']));
		expect(toolsHashOf(['a'])).not.toBe(toolsHashOf(['a', 'b']));
	});
});

describe('isPrefixOf', () => {
	it('accepts the start of a longer list and rejects a change', () => {
		expect(isPrefixOf(hashAll(['u1', 'a1']), hashAll(['u1', 'a1', 'u2']))).toBe(true);
		expect(isPrefixOf(hashAll(['u1', 'x']), hashAll(['u1', 'a1', 'u2']))).toBe(false);
		expect(isPrefixOf(hashAll(['u1', 'a1', 'u2']), hashAll(['u1', 'a1']))).toBe(false);
	});
});

describe('mismatchOf', () => {
	it('names what changed', () => {
		expect(mismatchOf(saved('k', ['u1']), check)).toBeUndefined();
		expect(mismatchOf(saved('k', ['u1'], { cwd: '/other' }), check)).toContain('folder');
		expect(mismatchOf(saved('k', ['u1'], { toolsHash: 'x' }), check)).toContain('tools');
		expect(mismatchOf(saved('k', ['u1'], { guidanceHash: 'x' }), check)).toContain('guidance');
	});
});

describe('SavedSessionStore', () => {
	function memento(): vscode.Memento {
		const values = new Map<string, unknown>();
		return {
			keys: () => [...values.keys()],
			get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
			update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
		} as vscode.Memento;
	}

	it('replaces the entry of a key and forgets it', () => {
		const store = new SavedSessionStore(memento());
		store.save({ ...saved('k', ['u1']), savedAt: Date.now() });
		store.save({ ...saved('k', ['u1', 'u2']), sessionId: 'next', savedAt: Date.now() });
		expect(store.all()).toHaveLength(1);
		expect(store.find('k')?.sessionId).toBe('next');
		store.forget('k');
		expect(store.find('k')).toBeUndefined();
	});

	it('drops entries that are too old', () => {
		const store = new SavedSessionStore(memento());
		store.save({ ...saved('old', ['u1']), savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
		expect(store.all()).toHaveLength(0);
	});

	it('does nothing without extension state', () => {
		const store = new SavedSessionStore(undefined);
		store.save(saved('k', ['u1']));
		expect(store.all()).toEqual([]);
	});
});
