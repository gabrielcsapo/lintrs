import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/test.ts", "**/*.test.ts", "**/tests/**", "**/test/**"] },
  ...tseslint.configs.recommendedTypeChecked.map(config => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.bench.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
