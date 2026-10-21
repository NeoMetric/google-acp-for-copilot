/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["vscode"],
	sourcemap: true,
	logLevel: "info"
};

/** @type {import('esbuild').BuildOptions} */
const options = tests
	? {
		...shared,
		// The smoke tests run inside the extension host, next to the bundled extension.
		entryPoints: ["test/smoke/extension.test.ts"],
		outfile: "out/test/extension.test.js",
		external: ["vscode", "mocha"]
	}
	: {
		...shared,
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.js",
		minify: !watch
	};

async function main() {
	if (watch) {
		const context = await esbuild.context(options);
		await context.watch();
	} else {
		await esbuild.build(options);
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
