// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'adapter/**', '*.vsix'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts', 'test/**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			curly: ['error', 'all'],
			eqeqeq: ['error', 'always'],
			'no-throw-literal': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', prefer: 'type-imports' }],
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			// Tests poke at JSON bodies and private state.
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
		...tseslint.configs.disableTypeChecked,
		languageOptions: {
			globals: { require: 'readonly', process: 'readonly', console: 'readonly', module: 'readonly', __dirname: 'readonly' },
		},
		rules: {
			...tseslint.configs.disableTypeChecked.rules,
			'@typescript-eslint/no-require-imports': 'off',
		},
	},
);
