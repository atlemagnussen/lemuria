import type { SchemaInfo } from './api.js';

/**
 * Unqualified column completion for the common case: the columns of the tables named in the
 * current statement's FROM / JOIN / UPDATE clauses, offered wherever a column can go
 * (SELECT list, WHERE, ON, ORDER BY, SET, ...). Qualified `alias.col` completion is left to lang-sql.
 *
 * Pure (no editor dependency) so it can be tested with plain strings. Deliberately simple scope
 * rules: every table referenced anywhere in the statement is in scope; derived tables and CTE
 * columns are not resolved.
 */

export interface ColumnSuggestion {
  /** Column name (quoted if needed): what the typed word is matched against. */
  label: string;
  /** Text inserted: the label, or `o.Name` when several tables in scope have that column. */
  insert: string;
  /** e.g. `o · nvarchar(50)` */
  detail: string;
}

export interface ColumnCompletion {
  /** Document offset where the word being completed starts. */
  from: number;
  options: ColumnSuggestion[];
}

interface Token {
  kind: 'word' | 'quoted' | 'number' | 'punct' | 'string';
  /** Upper-cased for words; unquoted name for quoted identifiers; raw text otherwise. */
  value: string;
  /** Original identifier text (for words and quoted identifiers). */
  name: string;
  from: number;
  to: number;
}

interface TableRef {
  schema: string | null;
  table: string;
  alias: string | null;
}

/** Keywords after which the next identifier is a table, not a column. */
const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'APPLY']);

/** Keywords after which a column (or expression) can start. */
const COLUMN_KEYWORDS = new Set([
  'SELECT', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'BY', 'HAVING', 'SET', 'DISTINCT', 'ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'IN', 'BETWEEN', 'LIKE', 'IS', 'RETURNING', 'OVER', 'PARTITION',
]);

/** Words that can't be a table alias (they start the next clause instead). */
const CLAUSE_WORDS = new Set([
  'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'GROUP', 'ORDER',
  'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'SET', 'WITH', 'OPTION', 'LIMIT', 'OFFSET', 'FETCH',
  'SELECT', 'FROM', 'AS', 'USING', 'NATURAL', 'LATERAL', 'APPLY', 'OUTPUT', 'RETURNING', 'VALUES',
  'WINDOW', 'FOR', 'INTO', 'GO',
]);

export interface ColumnOptions {
  /** Schema used for unqualified table names (dbo / public). */
  defaultSchema: string;
  /** How to quote identifiers that need it. */
  quoting: 'brackets' | 'double';
  /** Completion was requested explicitly (Ctrl+Space): allow an empty word. */
  explicit?: boolean;
}

export function completeColumns(doc: string, pos: number, schema: SchemaInfo, opts: ColumnOptions): ColumnCompletion | null {
  const { start, end } = statementBounds(doc, pos);
  const tokens = tokenize(doc, start, end);

  if (insideStringOrComment(doc, start, pos)) return null;

  const wordMatch = /[\p{L}\p{N}_$#@]*$/u.exec(doc.slice(start, pos))!;
  const word = wordMatch[0];
  const from = pos - word.length;
  if (!word && !opts.explicit) return null;
  if (/^\d/.test(word)) return null;

  const before = tokens.filter((t) => t.to <= from);
  const prev = before.at(-1);
  if (prev?.kind === 'punct' && prev.value === '.') return null; // qualified: lang-sql handles it
  if (!columnPosition(before)) return null;

  const resolved = tableRefs(tokens)
    .map((r) => ({ ref: r, obj: resolve(schema, r, opts.defaultSchema) }))
    .filter((x): x is { ref: TableRef; obj: ResolvedObject } => x.obj !== null);
  if (resolved.length === 0) return null;

  const count = new Map<string, number>();
  for (const { obj } of resolved)
    for (const c of obj.columns) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);

  const options: ColumnSuggestion[] = [];
  const seen = new Set<string>();
  for (const { ref, obj } of resolved) {
    const qualifier = ref.alias ?? obj.name;
    for (const c of obj.columns) {
      const ambiguous = (count.get(c.name.toLowerCase()) ?? 0) > 1;
      const q = (n: string) => quote(n, opts.quoting);
      const insert = ambiguous ? `${q(qualifier)}.${q(c.name)}` : q(c.name);
      if (seen.has(insert.toLowerCase())) continue; // same table referenced twice without aliases
      seen.add(insert.toLowerCase());
      options.push({ label: q(c.name), insert, detail: `${qualifier} · ${c.dataType}` });
    }
  }
  return { from, options };
}

/** Is the cursor (after `before`) a place where a column name can start? */
function columnPosition(before: Token[]): boolean {
  const prev = before.at(-1);
  if (!prev) return false;

  // Which clause are we in? A comma in a FROM list means another table, not a column.
  const clause = [...before].reverse().find((t) => t.kind === 'word' && (TABLE_KEYWORDS.has(t.value) || COLUMN_KEYWORDS.has(t.value) || CLAUSE_WORDS.has(t.value)));
  if (prev.kind === 'word') {
    if (TABLE_KEYWORDS.has(prev.value)) return false;
    if (COLUMN_KEYWORDS.has(prev.value)) return true;
    return false; // after an identifier: alias / next keyword position
  }
  if (prev.kind === 'number') {
    // SELECT TOP 10 |
    const p2 = before.at(-2);
    return p2?.kind === 'word' && p2.value === 'TOP';
  }
  if (prev.kind === 'punct') {
    if (prev.value === ',' && clause && clause.kind === 'word' && TABLE_KEYWORDS.has(clause.value)) return false;
    if (prev.value === ')') {
      // SELECT TOP (10) |
      const open = matchingOpen(before, before.length - 1);
      return open > 0 && before[open - 1].kind === 'word' && before[open - 1].value === 'TOP';
    }
    return [',', '(', '=', '<', '>', '<=', '>=', '<>', '!=', '+', '-', '*', '/', '%', '||'].includes(prev.value);
  }
  return false;
}

function matchingOpen(tokens: Token[], close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (tokens[i].value === ')') depth++;
    else if (tokens[i].value === '(' && --depth === 0) return i;
  }
  return -1;
}

/** Table references after FROM / JOIN / UPDATE / APPLY, including comma lists in FROM. */
function tableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word' || !['FROM', 'JOIN', 'UPDATE'].includes(t.value)) continue;
    let j = i + 1;
    for (;;) {
      const parsed = readTable(tokens, j);
      if (!parsed) break;
      refs.push(parsed.ref);
      j = parsed.next;
      if (t.value === 'FROM' && tokens[j]?.value === ',') { j++; continue; }
      break;
    }
  }
  return refs;
}

function readTable(tokens: Token[], i: number): { ref: TableRef; next: number } | null {
  const parts: string[] = [];
  while (isIdent(tokens[i])) {
    parts.push(tokens[i].name);
    i++;
    if (tokens[i]?.value === '.' && isIdent(tokens[i + 1])) { i++; continue; }
    break;
  }
  if (parts.length === 0) return null;
  if (tokens[i]?.value === '(') return null; // table-valued function call

  let alias: string | null = null;
  if (tokens[i]?.kind === 'word' && tokens[i].value === 'AS' && isIdent(tokens[i + 1])) {
    alias = tokens[i + 1].name;
    i += 2;
  } else if (isIdent(tokens[i]) && !(tokens[i].kind === 'word' && CLAUSE_WORDS.has(tokens[i].value))) {
    alias = tokens[i].name;
    i++;
  }
  // WITH (NOLOCK) and similar table hints
  if (tokens[i]?.kind === 'word' && tokens[i].value === 'WITH' && tokens[i + 1]?.value === '(') {
    while (i < tokens.length && tokens[i].value !== ')') i++;
    i++;
  }
  const table = parts.at(-1)!;
  const schema = parts.length >= 2 ? parts.at(-2)! : null;
  return { ref: { schema, table, alias }, next: i };
}

function isIdent(t: Token | undefined): t is Token {
  return !!t && (t.kind === 'quoted' || (t.kind === 'word' && !TABLE_KEYWORDS.has(t.value) && !COLUMN_KEYWORDS.has(t.value)));
}

interface ResolvedObject {
  name: string;
  columns: { name: string; dataType: string }[];
}

function resolve(info: SchemaInfo, ref: TableRef, defaultSchema: string): ResolvedObject | null {
  const eq = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
  const find = (schemaName: string) =>
    info.schemas.find((s) => eq(s.name, schemaName))?.objects.find((o) => eq(o.name, ref.table)) ?? null;

  if (ref.schema) return find(ref.schema);
  const preferred = find(defaultSchema);
  if (preferred) return preferred;
  for (const s of info.schemas) {
    const o = s.objects.find((x) => eq(x.name, ref.table));
    if (o) return o;
  }
  return null;
}

function quote(name: string, quoting: ColumnOptions['quoting']): string {
  if (/^[\p{L}_][\p{L}\p{N}_$#@]*$/u.test(name)) return name;
  return quoting === 'brackets' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}

/** The statement around `pos`: delimited by `;` or a line holding only `GO`, ignoring strings/comments. */
function statementBounds(doc: string, pos: number): { start: number; end: number } {
  let start = 0;
  let end = doc.length;
  scan(doc, 0, doc.length, (i, ch) => {
    let sepFrom = -1;
    let sepTo = -1;
    if (ch === ';') { sepFrom = i; sepTo = i + 1; }
    else if ((ch === 'G' || ch === 'g') && (i === 0 || doc[i - 1] === '\n')) {
      const m = /^[Gg][Oo][ \t]*(?:\r?\n|$)/.exec(doc.slice(i, i + 64));
      if (m) { sepFrom = i; sepTo = i + m[0].length; }
    }
    if (sepFrom < 0) return true;
    if (sepTo <= pos) start = sepTo;
    else if (sepFrom >= pos) { end = sepFrom; return false; }
    return true;
  });
  return { start, end };
}

/** Walk code characters, skipping strings, quoted identifiers and comments. */
function scan(doc: string, from: number, to: number, onCode: (i: number, ch: string) => boolean) {
  let i = from;
  while (i < to) {
    const ch = doc[i];
    const next = doc[i + 1];
    if (ch === '-' && next === '-') { const nl = doc.indexOf('\n', i); i = nl < 0 ? to : nl; continue; }
    if (ch === '/' && next === '*') { const e = doc.indexOf('*/', i + 2); i = e < 0 ? to : e + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < to) {
        if (doc[j] === close) { if (doc[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (!onCode(i, ch)) return;
    i++;
  }
}

/** Does a string, quoted identifier or comment opened in [start, pos) remain open at pos? */
function insideStringOrComment(doc: string, start: number, pos: number): boolean {
  let i = start;
  while (i < pos) {
    const ch = doc[i];
    const next = doc[i + 1];
    if (ch === '-' && next === '-') {
      const nl = doc.indexOf('\n', i);
      if (nl < 0 || nl >= pos) return true;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const e = doc.indexOf('*/', i + 2);
      if (e < 0 || e + 2 > pos) return true;
      i = e + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < pos && doc[j] !== close) j++;
      if (j >= pos) return true;
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

function tokenize(doc: string, start: number, end: number): Token[] {
  const tokens: Token[] = [];
  let i = start;
  while (i < end) {
    const ch = doc[i];
    const next = doc[i + 1];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && next === '-') { const nl = doc.indexOf('\n', i); i = nl < 0 || nl > end ? end : nl; continue; }
    if (ch === '/' && next === '*') { const e = doc.indexOf('*/', i + 2); i = e < 0 || e + 2 > end ? end : e + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let text = '';
      while (j < end) {
        if (doc[j] === close) { if (doc[j + 1] === close) { text += close; j += 2; continue; } break; }
        text += doc[j++];
      }
      const kind = ch === "'" ? 'string' : 'quoted';
      tokens.push({ kind, value: text, name: text, from: i, to: Math.min(j + 1, end) });
      i = j + 1;
      continue;
    }
    const word = /^[\p{L}_$#@][\p{L}\p{N}_$#@]*/u.exec(doc.slice(i, Math.min(end, i + 256)));
    if (word) {
      tokens.push({ kind: 'word', value: word[0].toUpperCase(), name: word[0], from: i, to: i + word[0].length });
      i += word[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(doc.slice(i, Math.min(end, i + 64)));
    if (num) {
      tokens.push({ kind: 'number', value: num[0], name: num[0], from: i, to: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const op = /^(<=|>=|<>|!=|\|\||::)/.exec(doc.slice(i, i + 2));
    const text = op ? op[0] : ch;
    tokens.push({ kind: 'punct', value: text, name: text, from: i, to: i + text.length });
    i += text.length;
  }
  return tokens;
}
