import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: 'stable',
	// Only the extension under test: no Copilot, no other extensions.
	launchArgs: ['--disable-extensions'],
	mocha: { ui: 'tdd', timeout: 30_000 },
});
