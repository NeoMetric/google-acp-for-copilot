/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/customizations';

describe('parseFrontmatter', () => {
	it('reads plain, double quoted and single quoted values', () => {
		expect(parseFrontmatter('---\nname: plain\ndescription: "say \\"hi\\" \\\\ ok"\nother: \'it\'\'s\'\n---\nbody')).toEqual({
			name: 'plain',
			description: 'say "hi" \\ ok',
			other: "it's",
		});
	});

	it('keeps colons and dashes inside a value', () => {
		expect(parseFrontmatter('---\ndescription: **WORKFLOW** — USE FOR: a, b. DO NOT USE FOR: c\n---')).toEqual({
			description: '**WORKFLOW** — USE FOR: a, b. DO NOT USE FOR: c',
		});
	});

	it('joins block values that continue on indented lines', () => {
		expect(parseFrontmatter('---\ndescription: >-\n  first line\n  second line\nname: next\n---')).toEqual({
			description: 'first line second line',
			name: 'next',
		});
	});

	it('copes with CRLF line endings and a byte order mark', () => {
		expect(parseFrontmatter('\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nbody')).toEqual({ name: 'a', description: 'b' });
	});

	it('is empty without a frontmatter block', () => {
		expect(parseFrontmatter('# Just a heading\nname: not frontmatter')).toEqual({});
		expect(parseFrontmatter('---\nname: never closed')).toEqual({});
	});
});
