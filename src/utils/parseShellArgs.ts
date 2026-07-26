/**
 * Parse a shell-like argument string respecting single/double quotes.
 * E.g. `--path "/Users/me/My Folder" --verbose` → ['--path', '/Users/me/My Folder', '--verbose']
 *
 * Limitations: does not support backslash escaping inside quotes.
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '\'' | '"' | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) { quote = null; continue }
      current += ch
    } else if (ch === '"' || ch === '\'') {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) { args.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) args.push(current)
  return args
}
