import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "logs/**", "config/*.json", "android/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["error", "always"],
      "curly": ["warn", "all"],
      "no-throw-literal": "error",
      "no-eval": "error",
      "no-implied-eval": "error"
    }
  },
  {
    files: ["electron/**/*.js", "web/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  }
];
