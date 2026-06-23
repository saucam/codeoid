// Flat ESLint config (ESLint v9) for the SolidJS web UI.
// TypeScript-aware linting + SolidJS reactivity rules.
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "*.config.*", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "tsconfig.json",
      },
    },
  },
  {
    // Allow underscore-prefixed names as intentional "unused" placeholders.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
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
    // Tests use jsdom globals and looser typing.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
