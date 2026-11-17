import tseslint from "typescript-eslint";
import bench from "./.lintrs-bench/rules/native.mjs";

export default [
  { ignores: ["**/test.ts", "**/*.test.ts", "**/tests/**", "**/test/**"] },
  {
    files: ["src/**/*.ts"],
    plugins: { bench },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.bench.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "bench/call-returns-union": "error" },
  },
];
