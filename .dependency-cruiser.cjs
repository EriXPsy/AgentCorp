/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'Prevent cyclic dependencies in the focused a11y-governance slice.',
      from: {
        path: '^(src/pages/Activity/|src/pages/Settings/|src/components/workbench/)',
      },
      to: {
        circular: true,
      },
    },
    {
      name: 'renderer-must-not-import-electron-main',
      severity: 'error',
      comment: 'Renderer code must call host-api/api-client instead of importing electron main code. Types shared across processes live in shared/.',
      from: {
        path: '^src/',
      },
      to: {
        path: '^electron/',
      },
    },
    {
      name: 'electron-main-must-not-import-renderer',
      severity: 'error',
      comment: 'Main process code should stay isolated from renderer internals.',
      from: {
        path: '^electron/',
      },
      to: {
        path: '^src/',
      },
    },
    // ===== 层级规则（refactor PR-1 起，经 dep-ratchet 棘轮过渡到零）=====
    {
      name: 'pages-must-not-import-other-pages',
      severity: 'error',
      comment: '页面之间不得互相 import；共享 UI 进 components/，共享状态进 stores/。',
      from: { path: '^src/pages/[^/]+/' },
      to: { path: '^src/pages/[^/]+/', pathNot: '$1' },
    },
    {
      name: 'components-must-not-import-pages',
      severity: 'error',
      comment: '组件是被页面消费的下层，不得反向依赖页面。',
      from: { path: '^src/components/' },
      to: { path: '^src/pages/' },
    },
    {
      name: 'engine-must-not-import-react',
      severity: 'error',
      comment: 'engine/ 是纯逻辑层（无 React、无 zustand），保持可在 Node 单测直接驱动。',
      from: { path: '^src/engine/' },
      to: { path: 'node_modules/(react|react-dom|zustand)' },
    },
    {
      name: 'stores-must-not-import-pages-or-components',
      severity: 'error',
      comment: 'stores/ 是状态层，不得依赖视图层（pages/components）。',
      from: { path: '^src/stores/' },
      to: { path: '^src/(pages|components)/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: '(^|/)(build|continue|dist|dist-electron|docs|openclaw|reference|release|resources|runtime|test-results)(/|$)',
    includeOnly: '^(src|electron|shared)/',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
  },
};
