import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// The real module only exists inside the extension host.
			vscode: path.resolve(import.meta.dirname, 'test/unit/vscode-mock.ts'),
		},
	},
	test: {
		include: ['test/unit/**/*.test.ts'],
	},
});
