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
      // 同理：规则不区分 TS 的值空间与类型空间，会把
      // `const X = {...} as const` + `type X = ...`（const enum 的惯用替代）误判为重复声明。
      // TS-aware 变体的 ignoreDeclarationMerge 也不覆盖这种配对；真正的重复声明由 tsc 报错。
      'no-redeclare': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // 体积门禁第一阶段（refactor PR-1）：先 warn 建立可见性，PR-5 收紧为 error。
      // 配合 scripts/qa/size-budget.mjs（>600 行 ratchet，只减不增）双轨推进。
      'max-lines': ['warn', { max: 400, skipBlankLines: true }],
      'max-lines-per-function': ['warn', { max: 80 }],
    },
  },
  {
    // React 组件（含容器组件）函数体天然较长，放宽到 250；
    // 仅作用于组件文件，普通 .ts 逻辑文件仍按 80 触发。
    files: ['src/**/*.tsx', 'electron/**/*.tsx'],
    rules: {
      'max-lines-per-function': ['warn', { max: 250 }],
    },
  },
  {
    // 测试文件不适用行数门禁（fixture/setup 密集，且不在拆分范围内）。
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
    },
  },
];
