import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NODE_GLOBALS = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "internal/**",
      ".local-artifacts/**",
      ".local-runtime/**",
      "packages/database/drizzle/**",
      "tests/**/playwright-report/**",
      "tests/**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: NODE_GLOBALS },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
);
