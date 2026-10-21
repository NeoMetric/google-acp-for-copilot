/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { sessionKey } from '../../src/provider';
import { assistant, user } from './messages';

describe('sessionKey', () => {
	it('keeps one key as a chat grows', () => {
		const first = sessionKey([user('system'), user('fix the bug')]);
		const later = sessionKey([user('system'), user('fix the bug'), assistant('done'), user('thanks')]);

		expect(later).toBe(first);
	});

	it('separates chats that share a system prompt but open differently', () => {
		expect(sessionKey([user('system'), user('fix the bug')])).not.toBe(sessionKey([user('system'), user('write a test')]));
	});
});
