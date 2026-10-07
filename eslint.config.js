import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        // Every pattern needs the `**/` prefix. In flat config a bare `dist/`
        // matches only the lint root, so each package's own `dist/` was being
        // linted and reporting errors in generated output.
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/coverage/**",
            "**/.turbo/**",
            "**/.kilo/**",
            "examples/",
        ],
    },

    eslint.configs.recommended,

    {
        // Node globals. Without this, `no-undef` from the recommended set
        // flags every `console`, `process`, and `Buffer` reference in a
        // Node-only codebase. They are declared rather than disabled because
        // `no-undef` still usefully catches typos in local identifiers.
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },

    {
        // Set explicitly rather than relying on auto-discovery, which picks up
        // every tsconfig.json beneath the lint root and becomes ambiguous as
        // soon as a second one exists. This also stops agent worktrees (which
        // carry their own tsconfig and their own eslint.config.js) from being
        // picked up as candidates.
        languageOptions: {
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    tseslint.configs.recommended,

    {
        rules: {
            // `_`-prefixed names are the codebase's signal for "deliberately
            // unused". The main use is omit-by-destructuring, e.g.
            // `const { query: _query, ...rest } = obj`, which has no other way
            // to express the intent.
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },

    {
        // Tests assert on parsed log records, whose shape is deliberately
        // unconstrained: a test that reached for a field the serializer does not
        // emit should fail at runtime with `undefined`, not at compile time.
        // Expressing that with `unknown` would force a cast at every assertion
        // and make the assertions less readable, not safer.
        files: ["**/test/**/*.ts", "**/tests/**/*.ts", "**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },

    {
        // Examples are run as scripts and read loosely-typed stream chunks and
        // parsed JSON for display.
        files: ["**/examples/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
);
