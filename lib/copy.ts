import en from '../copy/en.json';

// Tiny ICU MessageFormat reader for copy/en.json (byte-copy of handoff/copy/en.json).
// Supports `{name}` substitution and `{count, plural, =0 {…} one {…} other {…}}`.
// No react-intl: the handoff keys are all simple enough for this helper.

export type CopyVars = Record<string, string | number>;

type CopyTree = { [key: string]: string | CopyTree };

export const copy = en as unknown as CopyTree;

export function t(path: string, vars: CopyVars = {}): string {
  const message = lookup(path);
  if (typeof message !== 'string') {
    throw new Error(`copy key not found: ${path}`);
  }
  return format(message, vars);
}

export function hasCopy(path: string): boolean {
  return typeof lookup(path) === 'string';
}

function lookup(path: string): string | CopyTree | undefined {
  let node: string | CopyTree | undefined = copy;
  for (const segment of path.split('.')) {
    if (node === undefined || typeof node === 'string') {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

export function format(message: string, vars: CopyVars): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open === -1) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const close = matchingBrace(message, open);
    if (close === -1) {
      out += message.slice(open);
      break;
    }
    out += formatArgument(message.slice(open + 1, close), vars);
    i = close + 1;
  }
  return out;
}

function matchingBrace(message: string, open: number): number {
  let depth = 0;
  for (let i = open; i < message.length; i += 1) {
    if (message[i] === '{') {
      depth += 1;
    } else if (message[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function formatArgument(argument: string, vars: CopyVars): string {
  const firstComma = argument.indexOf(',');
  if (firstComma === -1) {
    const name = argument.trim();
    return name in vars ? String(vars[name]) : `{${name}}`;
  }
  const name = argument.slice(0, firstComma).trim();
  const rest = argument.slice(firstComma + 1);
  const secondComma = rest.indexOf(',');
  const kind = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
  const options = secondComma === -1 ? '' : rest.slice(secondComma + 1);
  if (kind !== 'plural') {
    return name in vars ? String(vars[name]) : `{${name}}`;
  }
  const value = Number(vars[name] ?? 0);
  const branches = parsePluralOptions(options);
  const chosen =
    branches.get(`=${value}`) ??
    (value === 1 ? branches.get('one') : undefined) ??
    branches.get('other') ??
    '';
  return format(chosen.replace(/#/g, String(value)), vars);
}

function parsePluralOptions(options: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < options.length) {
    const open = options.indexOf('{', i);
    if (open === -1) {
      break;
    }
    const key = options.slice(i, open).trim();
    const close = matchingBrace(options, open);
    if (close === -1) {
      break;
    }
    branches.set(key, options.slice(open + 1, close));
    i = close + 1;
  }
  return branches;
}
