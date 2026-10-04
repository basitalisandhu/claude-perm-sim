/**
 * A small POSIX-shell reader: enough to split a Bash tool command into the simple commands Claude Code
 * matches rules against. It recognises the documented separators (`&&`, `||`, `;`, `|`, `|&`, `&`,
 * newlines), commands nested in `$(...)`, backticks, `<(...)`, `>(...)` and `( ... )` subshells,
 * control-flow keywords, quoting, comments, here-documents and redirections. It does not expand
 * anything. When it cannot follow the text it says so, and allow rules then do not apply.
 */

export interface Redirect {
  op: string;
  /** File target, or undefined for fd duplication (`2>&1`) and here-documents. */
  target?: string;
}

export interface SimpleCommand {
  /** The text the command occupies in its source, from the first word to the last word. */
  text: string;
  /** Unquoted word values. */
  words: string[];
  /** Offsets of each word in `source`. */
  starts: number[];
  ends: number[];
  source: string;
  redirects: Redirect[];
  /** True when this command sits inside a substitution or a subshell. */
  nested: boolean;
}

export interface ParsedCommand {
  commands: SimpleCommand[];
  /** True when the text could not be split reliably (unbalanced quotes, a dangling `&&`, ...). */
  unparseable: boolean;
  reasons: string[];
}

const KEYWORDS_STRIP = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac']);

/** Index just past the `)` that closes the `(` at `open`, honouring quotes. -1 if unbalanced. */
function findParenClose(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '"') {
      const j = findDoubleQuoteEnd(src, i);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '`') {
      const j = findBacktickEnd(src, i);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function findBacktickEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '`') return i;
  }
  return -1;
}

/** Index of the closing `"` for the quote at `open`. -1 if unbalanced. */
function findDoubleQuoteEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"') return i;
    if (c === '$' && src[i + 1] === '(') {
      const j = findParenClose(src, i + 1);
      if (j < 0) return -1;
      i = j - 1;
      continue;
    }
    if (c === '`') {
      const j = findBacktickEnd(src, i);
      if (j < 0) return -1;
      i = j;
    }
  }
  return -1;
}

export function parseCommand(src: string): ParsedCommand {
  const out: ParsedCommand = { commands: [], unparseable: false, reasons: [] };
  parseInto(src, false, out);
  return out;
}

function parseInto(src: string, nested: boolean, out: ParsedCommand): void {
  let words: string[] = [];
  let starts: number[] = [];
  let ends: number[] = [];
  let redirects: Redirect[] = [];
  let cur: { start: number; value: string } | null = null;
  let pendingRedirect: string | null = null;
  let pendingHeredocs: { delim: string }[] = [];

  const fail = (reason: string): void => {
    out.unparseable = true;
    if (!out.reasons.includes(reason)) out.reasons.push(reason);
  };

  const finishWord = (end: number): void => {
    if (!cur) return;
    if (pendingRedirect !== null) {
      const op = pendingRedirect;
      pendingRedirect = null;
      if (op === '<<' || op === '<<-') {
        pendingHeredocs.push({ delim: cur.value });
        redirects.push({ op });
      } else if (op === '<<<') {
        redirects.push({ op });
      } else if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(cur.value)) {
        redirects.push({ op });
      } else {
        redirects.push({ op, target: cur.value });
      }
    } else {
      words.push(cur.value);
      starts.push(cur.start);
      ends.push(end);
    }
    cur = null;
  };

  const finishCommand = (): void => {
    if (pendingRedirect !== null) {
      fail(`redirection ${pendingRedirect} has no target`);
      pendingRedirect = null;
    }
    // Strip control-flow keywords that precede the command.
    let k = 0;
    while (k < words.length && KEYWORDS_STRIP.has(words[k])) k++;
    if (k < words.length && (words[k] === 'for' || words[k] === 'select')) {
      k = words.length; // loop header, not a command
    } else if (k < words.length && (words[k] === 'case' || words[k] === 'function' || /\(\)$/.test(words[k]))) {
      fail(`${words[k]} constructs are not followed`);
      k = words.length;
    }
    if (k < words.length) {
      const ws = words.slice(k);
      const ss = starts.slice(k);
      const es = ends.slice(k);
      out.commands.push({
        text: src.slice(ss[0], es[es.length - 1]).trim(),
        words: ws,
        starts: ss,
        ends: es,
        source: src,
        redirects,
        nested,
      });
    } else if (redirects.length > 0) {
      out.commands.push({ text: '', words: [], starts: [], ends: [], source: src, redirects, nested });
    }
    words = [];
    starts = [];
    ends = [];
    redirects = [];
  };

  const startWord = (i: number): void => {
    if (!cur) cur = { start: i, value: '' };
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\n') {
      finishWord(i); // completes a pending here-document delimiter word
    }
    if (c === '\n' && pendingHeredocs.length > 0) {
      finishCommand();
      // Skip the here-document bodies.
      let pos = i + 1;
      for (const { delim } of pendingHeredocs) {
        let found = false;
        while (pos <= src.length) {
          const nl = src.indexOf('\n', pos);
          const line = src.slice(pos, nl < 0 ? src.length : nl);
          pos = nl < 0 ? src.length + 1 : nl + 1;
          if (line.replace(/^\t+/, '') === delim) {
            found = true;
            break;
          }
        }
        if (!found) fail('here-document is not terminated');
      }
      pendingHeredocs = [];
      i = pos;
      continue;
    }

    if (c === ' ' || c === '\t') {
      finishWord(i);
      i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      startWord(i);
      cur!.value += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '#' && !cur) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) {
        fail('unbalanced single quote');
        return;
      }
      startWord(i);
      cur!.value += src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = findDoubleQuoteEnd(src, i);
      if (j < 0) {
        fail('unbalanced double quote');
        return;
      }
      startWord(i);
      const inner = src.slice(i + 1, j);
      cur!.value += inner;
      collectNested(inner, out);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = findBacktickEnd(src, i);
      if (j < 0) {
        fail('unbalanced backtick');
        return;
      }
      startWord(i);
      cur!.value += src.slice(i, j + 1);
      parseInto(src.slice(i + 1, j), true, out);
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const close = findParenClose(src, i + 1);
      if (close < 0) {
        fail('unbalanced $(');
        return;
      }
      startWord(i);
      cur!.value += src.slice(i, close);
      const isArith = src[i + 2] === '(';
      if (!isArith) parseInto(src.slice(i + 2, close - 1), true, out);
      i = close;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const close = findParenClose(src, i + 1);
      if (close < 0) {
        fail(`unbalanced ${c}(`);
        return;
      }
      startWord(i);
      cur!.value += src.slice(i, close);
      parseInto(src.slice(i + 2, close - 1), true, out);
      i = close;
      continue;
    }
    if (c === '(' && !cur && words.length === 0) {
      const close = findParenClose(src, i);
      if (close < 0) {
        fail('unbalanced (');
        return;
      }
      parseInto(src.slice(i + 1, close - 1), true, out);
      i = close;
      continue;
    }
    if (c === ')') {
      fail('unexpected )');
      i++;
      continue;
    }

    // Redirections.
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      const fdCur = cur as { start: number; value: string } | null;
      if (fdCur && /^\d+$/.test(fdCur.value) && fdCur.start + fdCur.value.length === i) {
        cur = null; // file descriptor prefix such as 2>
      } else {
        finishWord(i);
      }
      const ops = ['&>>', '&>', '<<<', '<<-', '<<', '>>', '>&', '<&', '>|', '<>', '>', '<'];
      const op = ops.find((o) => src.startsWith(o, i))!;
      pendingRedirect = op;
      i += op.length;
      continue;
    }

    // Command separators.
    const sep = ['&&', '||', '|&', ';;', '|', ';', '&', '\n'].find((o) => src.startsWith(o, i));
    if (sep !== undefined) {
      finishWord(i);
      finishCommand();
      i += sep.length;
      if (sep === '&&' || sep === '||' || sep === '|' || sep === '|&') {
        if (src.slice(i).trim() === '') fail(`nothing follows ${sep}`);
      }
      continue;
    }

    startWord(i);
    cur!.value += c;
    i++;
  }
  finishWord(src.length);
  finishCommand();
  if (pendingHeredocs.length > 0) fail('here-document is not terminated');
}

/** Commands inside a double-quoted string run too: `"$(git clean -f)"`. */
function collectNested(inner: string, out: ParsedCommand): void {
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      i++;
      continue;
    }
    if (inner[i] === '$' && inner[i + 1] === '(') {
      const close = findParenClose(inner, i + 1);
      if (close < 0) return;
      if (inner[i + 2] !== '(') parseInto(inner.slice(i + 2, close - 1), true, out);
      i = close - 1;
    } else if (inner[i] === '`') {
      const j = findBacktickEnd(inner, i);
      if (j < 0) return;
      parseInto(inner.slice(i + 1, j), true, out);
      i = j;
    }
  }
}
