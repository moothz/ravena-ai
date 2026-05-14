const js = require("@eslint/js");
const prettierPlugin = require("eslint-plugin-prettier");
const prettierConfig = require("eslint-config-prettier");
const globals = require("globals");

module.exports = [
	{
		ignores: [
			"node_modules/**",
			"whatsgoapi/**",
			"dist/**",
			"temp/**",
			"uploads/**",
			"media/**",
			"data/**",
			"public/**",
			"old/**",
			".Trash-1000/**",
			"!public/cmd.js",
			"!public/help.js",
			"!public/scripts.js",
			"!public/dashboard.js",
			"!public/management.js",
			"coverage/**"
		]
	},
	js.configs.recommended,
	{
		files: ["**/*.js"],
		plugins: {
			prettier: prettierPlugin
		},
		languageOptions: {
			globals: {
				...globals.node,
				...globals.es2021
			},
			sourceType: "commonjs",
			ecmaVersion: "latest"
		},
		rules: {
			...prettierConfig.rules,
			"prettier/prettier": "warn",

			"prefer-const": "warn",
			"no-var": "warn",
			"object-shorthand": "warn",
			"arrow-body-style": ["warn", "as-needed"],
			"no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^",
					varsIgnorePattern: "^",
					caughtErrors: "none"
				}
			],
			quotes: ["warn", "double", { avoidEscape: true, allowTemplateLiterals: true }],
			"no-empty": ["warn", { allowEmptyCatch: true }],
			"no-undef": "error",
			"no-constant-condition": ["warn", { checkLoops: false }],
			"no-constant-binary-expression": "off",
			"no-async-promise-executor": "off",
			"no-case-declarations": "off",
			"no-useless-escape": "warn",
			"no-control-regex": "off",
			"no-unreachable": "warn",
			"no-useless-catch": "warn"
		}
	},
	{
		files: ["public/**/*.js", "simulador/**/*.js"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.jquery,
				Highcharts: "readonly"
			}
		}
	}
];
