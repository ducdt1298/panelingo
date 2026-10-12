import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// Messaging rules (see src/shared/protocol.ts).
const ASYNC_LISTENER_RULE = {
  selector:
    "CallExpression[callee.property.name='addListener'] > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]",
  message:
    "chrome.* event listeners must be plain (non-async) functions: an async listener answers null first.",
};
const ON_MESSAGE_RULE = {
  selector:
    "MemberExpression[object.object.name='chrome'][object.property.name='runtime'][property.name='onMessage']",
  message: "Use onMessageFor() from src/platform/messaging.ts (plain listener, one Reply<T> per message).",
};
const ON_CONNECT_RULE = {
  selector:
    "MemberExpression[object.object.name='chrome'][object.property.name='runtime'][property.name='onConnect']",
  message:
    "Only src/engine/main.ts may listen to runtime.onConnect (a disconnect() by any receiver kills the port).",
};

// Node runs .ts by stripping types and does no extension resolution, so relative imports must name the file.
const TS_EXTENSION_RULES = [
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
].map((node) => ({
  selector: `${node}[source.value=/^\\.{1,2}\\//]:not([source.value=/\\.(ts|json)$/])`,
  message: "Relative imports must end in .ts (Node type stripping does not resolve extensions).",
}));

const NO_INNER_HTML = {
  selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
  message: "No innerHTML/outerHTML in content scripts (Trusted Types and XSS); build DOM nodes instead.",
};

const BROWSER_ONLY = [
  "chrome",
  "browser",
  "window",
  "document",
  "navigator",
  "location",
  "self",
  "OffscreenCanvas",
  "createImageBitmap",
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "fetch",
  "XMLHttpRequest",
];
const NODE_ONLY = ["process", "Buffer", "require", "module", "__dirname", "__filename", "global"];

export default defineConfig([
  {
    ignores: [
      "dist/**",
      // Personal unpacked builds made with `node scripts/build.ts --out=<dir>` (gitignored).
      "user-build/**",
      "build-*/**",
      "release/**",
      ".cache/**",
      "coverage/**",
      "reports/**",
      "private/**",
      "test/fixtures/generated/**",
      // Fixture pages are plain browser scripts served to the test browser, not project code.
      "test/fixtures/sites/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["**/*.js", "**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", name: ["test", "it", "describe", "suite"], package: "node:test" },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        ASYNC_LISTENER_RULE,
        ON_MESSAGE_RULE,
        ON_CONNECT_RULE,
        ...TS_EXTENSION_RULES,
      ],
    },
  },
  {
    files: ["src/platform/messaging.ts"],
    rules: { "no-restricted-syntax": ["error", ASYNC_LISTENER_RULE, ON_CONNECT_RULE, ...TS_EXTENSION_RULES] },
  },
  {
    files: ["src/engine/main.ts"],
    rules: { "no-restricted-syntax": ["error", ASYNC_LISTENER_RULE, ON_MESSAGE_RULE, ...TS_EXTENSION_RULES] },
  },
  {
    files: ["src/content/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ASYNC_LISTENER_RULE,
        ON_MESSAGE_RULE,
        ON_CONNECT_RULE,
        ...TS_EXTENSION_RULES,
        NO_INNER_HTML,
      ],
    },
  },
  {
    // Pure code: identical behaviour in Node tests and every Chrome context.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...BROWSER_ONLY, ...NODE_ONLY],
      "no-restricted-imports": [
        "error",
        {
          patterns: ["node:*", "**/platform/**", "**/engine/**", "**/content/**", "**/ui/**", "**/sw/**"],
        },
      ],
    },
  },
]);
