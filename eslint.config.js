import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Flat config (ESLint 10). Scope: application code only.
// Build/CI scripts under scripts/ are tooling, not app code — they are
// excluded so `pnpm lint` stays focused on real issues in the app.
export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'scripts/**',
      'resources/**',
      // 本地构建产物（git-ignored），含未加载插件的 eslint-disable 指令会误报
      'build/**',
    ],
  },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'electron/**/*.{ts,tsx}',
      'shared/**/*.{ts,tsx}',
      'tests/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      // TypeScript 自己处理未定义符号（NodeJS/Electron/React 等类型命名空间），
      // no-undef 对 TS 文件只会误报。
      'no-undef': 'off',
      // react-hooks v7 recommended 含 React Compiler 派生规则（set-state-in-effect 等），
      // 对存量代码噪音过大；只保留经典两条。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Base rule doesn't understand TS; defer to the TS-aware variant.
      // Kept at warn so style noise never fails the lint run outright.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        // 代码库约定：下划线前缀（_ctx / _nodeOptions 等）= 有意未用。
        // 一律忽略，避免对框架回调签名 / 占位变量刷 warning。
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
