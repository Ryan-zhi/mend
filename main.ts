// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ------------------------------------------------------------------ SPEC 3, 5
// A file's text as its lines, its line break and whether it ends with one.
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
// The first tier (0, 1, 2) at which O occurs in `lines`, and every position
// there; with strict only tier 0 is tried. Returns null when O never occurs.
function occurrences(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const norm = t === 0 ? (s: string) => s : t === 1 ? trimRight : trimBoth;
    const no = o.map(norm);
    const at: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (norm(lines[i + k]!) !== no[k]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}
// Replace the O lines at position `i` (found at `tier`) by N. `ctx` marks, for
// each line of N, the index into O it is a context line of, or null. Context
// lines are written as the file's own matched line; at tier 2 every other
// line of N is re-indented from O's first line's leading whitespace to the
// file's first matched line's.
function replaceLines(lines: string[], i: number, o: string[], n: string[], ctx: (number | null)[], tier: number): string[] {
  const out = lines.slice(0, i);
  const f = i < lines.length ? leadWs(lines[i]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (let j = 0; j < n.length; j++) {
    const c = ctx[j];
    if (c !== null && c !== undefined) {
      out.push(lines[i + c]!);
      continue;
    }
    let line = n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  out.push(...lines.slice(i + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------------ SPEC 6
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctx: (number | null)[];
  noEol: boolean;
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function uniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const isSectionStart = (j: number): boolean =>
    lines[j]!.startsWith('diff --git ') || (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '));
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      cur.oldPath = uniPath(line.slice(4));
      cur.newPath = uniPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = Number(m[1]);
      const body: { kind: string; text: string; backslash: boolean }[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          const kind = bl === '' ? ' ' : bl[0]!;
          body.push({ kind, text: kind === '\\' ? '' : bl.slice(1), backslash: false });
          i++;
          continue;
        }
        break;
      }
      // A `\` line refers to the body line before it; trailing empty lines are not part of the body.
      for (let k = 0; k < body.length; k++) {
        if (body[k]!.kind === '\\' && k > 0) body[k - 1]!.backslash = true;
      }
      let end = body.length;
      while (end > 0 && body[end - 1]!.kind === ' ' && body[end - 1]!.text === '') end--;
      const kept = body.slice(0, end);
      const o: string[] = [];
      const n: string[] = [];
      const ctx: (number | null)[] = [];
      let noEol = false;
      let lastCtxPlus = -1;
      for (let k = 0; k < kept.length; k++) {
        const b = kept[k]!;
        if (b.kind === ' ') {
          o.push(b.text);
          n.push(b.text);
          ctx.push(o.length - 1);
          lastCtxPlus = k;
        } else if (b.kind === '-') {
          o.push(b.text);
        } else if (b.kind === '+') {
          n.push(b.text);
          ctx.push(null);
          lastCtxPlus = k;
        }
      }
      if (lastCtxPlus >= 0 && lastCtxPlus + 1 < kept.length && kept[lastCtxPlus + 1]!.kind === '\\') noEol = true;
      cur.hunks.push({ a, o, n, ctx, noEol });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (cur.oldPath === null && cur.newPath === null) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.oldPath === null && cur.newPath === null) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    const isCreate = s.create || s.oldPath === null;
    const isDelete = s.del || s.newPath === null;
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (isCreate) {
      const np = newP;
      edits.push((tree) => {
        if (np === null || !safe(np)) throw new Fail('unsafe', np ?? '');
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (const h of s.hunks) {
          for (let j = 0; j < h.n.length; j++) if (h.ctx[j] === null) plus.push(h.n[j]!);
          if (h.noEol) noEol = true;
        }
        // The `\` after the last `+` line decides the final break.
        const lastH = s.hunks[s.hunks.length - 1];
        const lastPlus = lastH !== undefined && lastH.n.some((_, j) => lastH.ctx[j] === null);
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol && lastPlus ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      const op = oldP;
      edits.push((tree) => {
        if (op === null || !safe(op)) throw new Fail('unsafe', op ?? '');
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    if (isMove) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const after = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, after);
        tree.moves.push([oldP, newP]);
      });
      continue;
    }
    const p = oldP ?? newP;
    edits.push((tree) => {
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    });
  }
  return edits;
}
// Apply a section's hunks in order to a file's text.
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const nl = [...f.lines.slice(0, at), ...h.n, ...f.lines.slice(at)];
      const touchesEnd = at === f.lines.length;
      f = { lines: nl, br: f.br, final: touchesEnd ? !h.noEol : f.final };
      d += h.n.length;
      continue;
    }
    const occ = occurrences(f.lines, h.o, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.at[0]!;
    for (const pos of occ.at) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const touchesEnd = best + h.o.length === f.lines.length;
    const nl = replaceLines(f.lines, best, h.o, h.n, h.ctx, occ.tier);
    f = { lines: nl, br: f.br, final: touchesEnd ? !h.noEol : f.final };
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

// ------------------------------------------------------------------ SPEC 7
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index just after the previous block's REPLACE line (or -1)
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path: nearest line before SEARCH, after the previous block, not blank
    // and not starting with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    // Find ======= then >>>>>>> REPLACE.
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const f = splitFile(before);
        const occ = occurrences(f.lines, oldLines, strict);
        if (occ === null) throw new Fail('no-match', p);
        if (occ.at.length > 1) throw new Fail('ambiguous', p);
        const at = occ.at[0]!;
        const ctx: (number | null)[] = newLines.map((_, j) => null);
        // No context lines in a SEARCH/REPLACE block: every new line is new.
        const nl = replaceLines(f.lines, at, oldLines, newLines, ctx, occ.tier);
        tree.now.set(p, joinFile({ lines: nl, br: f.br, final: f.final }));
      });
    }
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ------------------------------------------------------------------ SPEC 8
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) body.push(bl.slice(1));
        else if (bl === '') body.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      // Blank lines at the end of a section are not part of it.
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File.
    const p = line.slice('*** Update File: '.length).trim();
    const updateLine = i;
    i++;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    interface Chunk {
      anchor: string | null;
      eof: boolean;
      o: string[];
      n: string[];
      ctx: (number | null)[];
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    const flush = (): void => {
      if (cur !== null) {
        // Trailing empty context lines are not part of a chunk.
        while (cur.o.length > 0 && cur.o[cur.o.length - 1] === '' && cur.n.length > 0 && cur.n[cur.n.length - 1] === '') {
          cur.o.pop();
          cur.n.pop();
          cur.ctx.pop();
        }
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const bl = lines[i]!;
      if (isSectionStart(bl)) break;
      if (bl === '*** End Patch') break;
      if (bl === '*** End of File') {
        if (cur === null) cur = { anchor: null, eof: true, o: [], n: [], ctx: [] };
        else cur.eof = true;
        flush();
        i++;
        continue;
      }
      if (bl.startsWith('@@')) {
        flush();
        const anchor = bl.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], ctx: [] };
        i++;
        continue;
      }
      if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') {
        if (cur === null) cur = { anchor: null, eof: false, o: [], n: [], ctx: [] };
        const kind = bl === '' ? ' ' : bl[0]!;
        const text = kind === ' ' ? bl.slice(1) : bl.slice(1);
        if (kind === ' ') {
          cur.o.push(text);
          cur.n.push(text);
          cur.ctx.push(cur.o.length - 1);
        } else if (kind === '-') {
          cur.o.push(text);
        } else {
          cur.n.push(text);
          cur.ctx.push(null);
        }
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    flush();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
    const mt = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
      let f = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          // First line at or after the cursor equal to the anchor, first tier with one.
          let found = -1;
          for (const t of strict ? [0] : [0, 1, 2]) {
            const norm = t === 0 ? (s: string) => s : t === 1 ? trimRight : trimBoth;
            const want = norm(ch.anchor);
            for (let k = cursor; k < f.lines.length; k++) {
              if (norm(f.lines[k]!) === want) {
                found = k;
                break;
              }
            }
            if (found >= 0) break;
          }
          if (found < 0) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        if (ch.o.length === 0) {
          const at = ch.eof ? f.lines.length : cursor;
          const nl = [...f.lines.slice(0, at), ...ch.n, ...f.lines.slice(at)];
          f = { lines: nl, br: f.br, final: f.final };
          cursor = at + ch.n.length;
          continue;
        }
        // First occurrence of O at or after the cursor, first tier with one.
        let occ: { tier: number; at: number[] } | null = null;
        let base = cursor;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const norm = t === 0 ? (s: string) => s : t === 1 ? trimRight : trimBoth;
          const no = ch.o.map(norm);
          const at: number[] = [];
          for (let k = base; k + ch.o.length <= f.lines.length; k++) {
            let ok = true;
            for (let m = 0; m < ch.o.length; m++) {
              if (norm(f.lines[k + m]!) !== no[m]) {
                ok = false;
                break;
              }
            }
            if (ok) {
              if (ch.eof && k + ch.o.length !== f.lines.length) continue;
              at.push(k);
              break;
            }
          }
          if (at.length > 0) {
            occ = { tier: t, at };
            break;
          }
        }
        if (occ === null) throw new Fail('no-match', p);
        const at = occ.at[0]!;
        const nl = replaceLines(f.lines, at, ch.o, ch.n, ch.ctx, occ.tier);
        f = { lines: nl, br: f.br, final: f.final };
        cursor = at + ch.n.length;
      }
      const after = joinFile(f);
      if (mt !== null) {
        tree.now.set(p, null);
        tree.now.set(mt, after);
        tree.moves.push([p, mt]);
      } else {
        tree.now.set(p, after);
      }
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order; a move is one `R old -> new`
  // line that sorts by its new path and replaces that pair's D and A lines.
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      consumed.add(oldP);
      consumed.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
