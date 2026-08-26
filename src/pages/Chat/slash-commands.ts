export interface ChatInputSlashCommand {
  key: 'help' | 'new' | 'stop' | 'agent' | 'cwd' | 'clear' | 'export' | 'memory' | 'cron' | 'settings';
  name: `/${string}`;
  description: string;
  argsHint?: string;
  aliases?: string[];
}

export interface ParsedChatInputSlashCommand {
  command: ChatInputSlashCommand;
  args: string;
}

export const CHAT_INPUT_SLASH_COMMANDS: ChatInputSlashCommand[] = [
  {
    key: 'new',
    name: '/new',
    description: 'Start a new session',
  },
  {
    key: 'stop',
    name: '/stop',
    description: 'Stop current run',
  },
  {
    key: 'agent',
    name: '/agent',
    argsHint: '<id|name|clear>',
    description: 'Set or clear target agent',
  },
  {
    key: 'cwd',
    name: '/cwd',
    argsHint: '<path|clear>',
    description: 'Set or clear working directory',
  },
  {
    key: 'help',
    name: '/help',
    aliases: ['?'],
    description: 'Show available slash commands',
  },
  {
    key: 'clear',
    name: '/clear',
    description: 'Start a fresh blank session',
  },
  {
    key: 'export',
    name: '/export',
    description: 'Export conversation as markdown',
  },
  {
    key: 'memory',
    name: '/memory',
    description: 'Open memory and knowledge settings',
  },
  {
    key: 'cron',
    name: '/cron',
    description: 'Open workforce planning',
  },
  {
    key: 'settings',
    name: '/settings',
    description: 'Open settings',
  },
];

function normalizeSlashInput(input: string): string {
  return input.trimStart();
}

function extractCommandToken(input: string): string {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith('/')) return '';
  const body = normalized.slice(1).toLowerCase();
  const firstSeparator = body.search(/[\s:]/u);
  return firstSeparator === -1 ? body : body.slice(0, firstSeparator);
}

export function isSlashCommandPrefixInput(input: string): boolean {
  const normalized = normalizeSlashInput(input);
  return /^\/[^\s:]*$/u.test(normalized);
}

export function getChatInputSlashMatches(input: string): ChatInputSlashCommand[] {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith('/')) return [];

  const token = extractCommandToken(normalized);
  if (!token) return CHAT_INPUT_SLASH_COMMANDS;

  return CHAT_INPUT_SLASH_COMMANDS.filter((command) => {
    if (command.key.startsWith(token)) return true;
    return (command.aliases ?? []).some((alias) => alias.startsWith(token));
  });
}

export function parseChatInputSlashCommand(input: string): ParsedChatInputSlashCommand | null {
  const normalized = normalizeSlashInput(input).trim();
  if (!normalized.startsWith('/')) return null;

  const body = normalized.slice(1);
  const firstSeparator = body.search(/[\s:]/u);
  const token = (firstSeparator === -1 ? body : body.slice(0, firstSeparator)).toLowerCase();
  if (!token) return null;

  let remainder = firstSeparator === -1 ? '' : body.slice(firstSeparator).trimStart();
  if (remainder.startsWith(':')) {
    remainder = remainder.slice(1).trimStart();
  }
  const args = remainder.trim();

  const command = CHAT_INPUT_SLASH_COMMANDS.find((entry) => {
    if (entry.key === token) return true;
    return (entry.aliases ?? []).includes(token);
  });
  if (!command) return null;

  return { command, args };
}
