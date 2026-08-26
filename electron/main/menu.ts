/**
 * Application Menu Configuration
 * Creates the native application menu for macOS/Windows/Linux.
 *
 * Menu policy:
 * - only link to routes that exist in the current product shell
 * - keep Help aligned with the public AgentCorp repository and docs
 * - avoid surfacing legacy navigation that no longer has a maintained screen
 */
import { Menu, app, shell, BrowserWindow } from 'electron';

const DOCS_URL = 'https://github.com/EriXPsy/AgentCorp';
const ARCHITECTURE_URL = 'https://github.com/EriXPsy/AgentCorp/blob/main/docs/architecture-blueprint.md';
const ISSUES_URL = 'https://github.com/EriXPsy/AgentCorp/issues';

function navigate(path: string): void {
  const win = BrowserWindow.getFocusedWindow();
  win?.webContents.send('navigate', path);
}

export function createMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            {
              label: 'Preferences…',
              accelerator: 'Cmd+,',
              click: () => navigate('/settings'),
            },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),

    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace',
          accelerator: 'CmdOrCtrl+N',
          click: () => navigate('/'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
            ]
          : [
              { role: 'delete' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const },
            ]),
      ],
    },

    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      label: 'Navigate',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => navigate('/') },
        { label: 'Sessions', accelerator: 'CmdOrCtrl+2', click: () => navigate('/chats') },
        { label: 'Marketplace', accelerator: 'CmdOrCtrl+3', click: () => navigate('/marketplace') },
        { label: 'Workforce', accelerator: 'CmdOrCtrl+4', click: () => navigate('/team-overview') },
        { label: 'Interview', accelerator: 'CmdOrCtrl+5', click: () => navigate('/interview') },
        { label: 'Evaluation', accelerator: 'CmdOrCtrl+6', click: () => navigate('/evaluation') },
        { label: 'Office', accelerator: 'CmdOrCtrl+7', click: () => navigate('/office') },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
          click: () => navigate('/settings'),
        },
      ],
    },

    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },

    {
      role: 'help',
      submenu: [
        {
          label: 'Product Overview',
          click: async () => {
            await shell.openExternal(DOCS_URL);
          },
        },
        {
          label: 'Architecture Blueprint',
          click: async () => {
            await shell.openExternal(ARCHITECTURE_URL);
          },
        },
        {
          label: 'Report Issue',
          click: async () => {
            await shell.openExternal(ISSUES_URL);
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
