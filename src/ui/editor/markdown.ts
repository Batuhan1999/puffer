// A note's Markdown as the Tiptap editor reads and writes it: a port of NoteMarkdown (modules/puffer-native/ios/Editor/
// NoteDocument.swift), so both editors store byte-identical Markdown. Every line is one paragraph, as in Apple Notes;
// CommonMark parsers (marked, markdown-it) join lines and need blank lines between blocks, which this format has not.
// scripts/editor-markdown-check/tiptap.mjs checks this file against the Swift original.
import type { JSONContent } from '@tiptap/core';

export type Highlight = 'purple' | 'pink' | 'orange' | 'mint' | 'blue';
export const HIGHLIGHTS: readonly Highlight[] = ['purple', 'pink', 'orange', 'mint', 'blue'];

export type TextStyle = 'title' | 'heading' | 'subheading' | 'body';
export type ListKind = 'bullet' | 'dash' | 'number' | 'unchecked' | 'checked';

export type Block =
  | { kind: 'text'; style: TextStyle; quoted: boolean }
  | { kind: 'list'; list: ListKind; indent: number; quoted: boolean }
  | { kind: 'mono' }
  /** Cells are separated by tab characters in the row's text. */
  | { kind: 'tableRow'; header: boolean };

export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;
export const STRIKE = 8;
export const CODE = 16;

export type InlineStyle = { marks: number; highlight?: Highlight; link?: string };
export type AttachmentRef = { name: string; file: string };
export type Inline = { text: string; style: InlineStyle } | { attachment: AttachmentRef };
export type Paragraph = { block: Block; inlines: Inline[] };

export const MAX_INDENT = 6;
const ATTACHMENT = 'attachment:';
/** A link to another note, written `[Title](puffer://note/<id>)`. */
export const NOTE_LINK = 'puffer://note/';

const plain = (): InlineStyle => ({ marks: 0 });
const sameStyle = (a: InlineStyle, b: InlineStyle) => a.marks === b.marks && a.highlight === b.highlight && a.link === b.link;
const isText = (i: Inline): i is { text: string; style: InlineStyle } => 'text' in i;
const body = (quoted = false): Block => ({ kind: 'text', style: 'body', quoted });

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const EDGE_SPACE = /^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu;

// MARK: parse

/** `implicitTitle`: the first line with text is the title, as in Apple Notes. Off for a pasted fragment. */
export function parse(markdown: string, implicitTitle = true): Paragraph[] {
  const lines = markdown.replace(/\r\n|\r|\u2028|\u2029/g, '\n').split('\n');
  const paragraphs: Paragraph[] = [];
  const listColumns: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.replace(/^ +/, '');
    if (trimmed.startsWith('```')) {
      listColumns.length = 0;
      i += 1;
      while (i < lines.length && !lines[i].replace(/^ +/, '').startsWith('```')) {
        paragraphs.push({ block: { kind: 'mono' }, inlines: lines[i] === '' ? [] : [{ text: lines[i], style: plain() }] });
        i += 1;
      }
      i += 1;
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      listColumns.length = 0;
      paragraphs.push({ block: { kind: 'tableRow', header: true }, inlines: tableCells(line) });
      i += 2;
      while (i < lines.length && lines[i].replace(/^ +/, '').startsWith('|')) {
        paragraphs.push({ block: { kind: 'tableRow', header: false }, inlines: tableCells(lines[i]) });
        i += 1;
      }
      continue;
    }
    paragraphs.push(parseLine(line, listColumns));
    i += 1;
  }
  const head = paragraphs[firstWithText(paragraphs)];
  if (implicitTitle && head && isPlainBody(head)) {
    // A leading empty line keeps the first text as Body (serialize writes it for a note whose first line was set to Body).
    if (paragraphs.length > 1 && paragraphs[0] !== head && paragraphs[0].inlines.length === 0) paragraphs.shift();
    else head.block = { kind: 'text', style: 'title', quoted: false };
  }
  return paragraphs;
}

const firstWithText = (paragraphs: Paragraph[]) => Math.max(0, paragraphs.findIndex((p) => p.inlines.length > 0));
const isPlainBody = (p: Paragraph) => p.block.kind === 'text' && p.block.style === 'body' && !p.block.quoted && p.inlines.length > 0;

function parseLine(line: string, listColumns: number[]): Paragraph {
  let rest = line;
  let quoted = false;
  if (rest.startsWith('>')) {
    quoted = true;
    rest = rest.slice(1);
    if (rest.startsWith(' ')) rest = rest.slice(1);
  }
  let column = 0;
  while (rest[0] === ' ' || rest[0] === '\t') {
    column += rest[0] === '\t' ? 4 : 1;
    rest = rest.slice(1);
  }
  const item = listItem(rest);
  if (item) {
    const top = listColumns[listColumns.length - 1];
    if (top !== undefined && column > top) {
      listColumns.push(column);
    } else {
      while (listColumns.length > 1 && column < listColumns[listColumns.length - 1]) listColumns.pop();
      if (listColumns.length === 0) listColumns.push(column);
    }
    const indent = Math.min(MAX_INDENT, listColumns.length - 1);
    return { block: { kind: 'list', list: item[0], indent, quoted }, inlines: parseInline(item[1]) };
  }
  listColumns.length = 0;
  const head = column === 0 ? heading(rest) : null;
  if (head) return { block: { kind: 'text', style: head[0], quoted }, inlines: parseInline(head[1]) };
  const text = column === 0 ? rest : ' '.repeat(column) + rest;
  return { block: body(quoted), inlines: parseInline(text) };
}

const CHECK_PREFIXES: readonly [string, ListKind][] = [
  ['- [ ] ', 'unchecked'], ['- [x] ', 'checked'], ['- [X] ', 'checked'], ['* [ ] ', 'unchecked'], ['* [x] ', 'checked'],
];

function listItem(s: string): [ListKind, string] | null {
  for (const [prefix, kind] of CHECK_PREFIXES) if (s.startsWith(prefix)) return [kind, s.slice(prefix.length)];
  if (s === '- [ ]') return ['unchecked', ''];
  if (s === '- [x]' || s === '- [X]') return ['checked', ''];
  if (s.startsWith('- ') || s === '-') return ['dash', s.slice(2)];
  if (s.startsWith('* ') || s.startsWith('+ ') || s === '*') return ['bullet', s.slice(2)];
  const digits = /^[0-9]*/.exec(s)![0];
  if (digits.length > 0 && digits.length < 10) {
    const after = s.slice(digits.length);
    if (after.startsWith('. ') || after.startsWith(') ')) return ['number', after.slice(2)];
    if (after === '.' || after === ')') return ['number', ''];
  }
  return null;
}

function heading(s: string): [TextStyle, string] | null {
  const hashes = /^#*/.exec(s)![0].length;
  if (hashes < 1 || hashes > 6) return null;
  const after = s.slice(hashes);
  if (after !== '' && !after.startsWith(' ')) return null;
  return [hashes === 1 ? 'title' : hashes === 2 ? 'heading' : 'subheading', after.replace(/^ +/, '')];
}

function isTableSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => {
    const c = cell.replace(EDGE_SPACE, '');
    return c.includes('-') && /^[-:]*$/.test(c);
  });
}

function splitRow(line: string): string[] {
  let s = line.replace(EDGE_SPACE, '');
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const c of s) {
    if (escaped) {
      if (c !== '|') cell += '\\';
      cell += c;
      escaped = false;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += c;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell);
  return cells;
}

function tableCells(line: string): Inline[] {
  const out: Inline[] = [];
  splitRow(line).forEach((cell, index) => {
    if (index > 0) out.push({ text: '\t', style: plain() });
    out.push(...parseInline(cell.replace(EDGE_SPACE, '')));
  });
  return merged(out);
}

// MARK: inline parse

type Delimiter = { open: string; close: string; flanking: boolean; apply: (s: InlineStyle, on: boolean) => void };
const setMark = (mark: number) => (s: InlineStyle, on: boolean) => { s.marks = on ? s.marks | mark : s.marks & ~mark; };

const DELIMITERS: readonly Delimiter[] = [
  { open: '**', close: '**', flanking: true, apply: setMark(BOLD) },
  { open: '__', close: '__', flanking: true, apply: setMark(BOLD) },
  { open: '~~', close: '~~', flanking: true, apply: setMark(STRIKE) },
  { open: '==', close: '==', flanking: true, apply: (s, on) => { s.highlight = on ? 'purple' : undefined; } },
  { open: '<u>', close: '</u>', flanking: false, apply: setMark(UNDERLINE) },
  { open: '*', close: '*', flanking: true, apply: setMark(ITALIC) },
  { open: '_', close: '_', flanking: true, apply: setMark(ITALIC) },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  let style = plain();
  const open: string[] = [];
  const chars = Array.from(text);
  let i = 0;

  const flush = () => {
    if (buffer !== '') out.push({ text: buffer, style: { ...style } });
    buffer = '';
  };
  const at = (s: string, index: number) => {
    const p = Array.from(s);
    if (index < 0 || index + p.length > chars.length) return false;
    return p.every((c, k) => chars[index + k] === c);
  };
  const find = (s: string, from: number, escapes = true): number | null => {
    let j = from;
    while (j < chars.length) {
      if (escapes && chars[j] === '\\') { j += 2; continue; }
      if (at(s, j)) return j;
      j += 1;
    }
    return null;
  };
  const isWordChar = (index: number) => index >= 0 && index < chars.length && LETTER_OR_NUMBER.test(chars[index]);
  const isSpace = (index: number) => index < 0 || index >= chars.length || WHITESPACE.test(chars[index]);

  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\' && i + 1 < chars.length && PUNCT_OR_SYMBOL.test(chars[i + 1])) {
      buffer += chars[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = at('``', i) ? '``' : '`';
      const end = find(ticks, i + ticks.length, false);
      if (end !== null && end > i + ticks.length) {
        flush();
        let code = chars.slice(i + ticks.length, end).join('');
        if (ticks === '``') code = code.replace(/^ +| +$/g, '');
        out.push({ text: code, style: { ...style, marks: style.marks | CODE } });
        i = end + ticks.length;
        continue;
      }
    }
    if (c === '!' && at('![', i)) {
      const parts = linkParts(chars, i + 1);
      if (parts && parts[1].startsWith(ATTACHMENT)) {
        flush();
        out.push({ attachment: { name: parts[0], file: parts[1].slice(ATTACHMENT.length) } });
        i = parts[2];
        continue;
      }
    }
    if (c === '[' && style.link === undefined) {
      const parts = linkParts(chars, i);
      if (parts) {
        flush();
        const [label, target, end] = parts;
        for (const inline of parseInline(label)) {
          if (isText(inline)) {
            out.push({ text: inline.text, style: { marks: inline.style.marks | style.marks, highlight: inline.style.highlight ?? style.highlight, link: target } });
          } else {
            out.push(inline);
          }
        }
        i = end;
        continue;
      }
    }
    if (c === '<' && at('<mark', i)) {
      const close = find('>', i);
      if (close !== null) {
        const tag = chars.slice(i, close + 1).join('');
        flush();
        style.highlight = HIGHLIGHTS.find((h) => tag.includes(`"${h}"`) || tag.includes(`'${h}'`)) ?? 'purple';
        open.push('</mark>');
        i = close + 1;
        continue;
      }
    }
    if (c === '<' && at('</mark>', i) && open.includes('</mark>')) {
      flush();
      style.highlight = undefined;
      open.splice(open.lastIndexOf('</mark>'), 1);
      i += 7;
      continue;
    }
    let matched = false;
    for (const d of DELIMITERS) {
      if (!at(d.open, i) && !at(d.close, i)) continue;
      if (open.includes(d.close) && at(d.close, i)) {
        if (d.flanking && isSpace(i - 1)) break;
        if (d.open === '_' && isWordChar(i + d.close.length)) break;
        flush();
        d.apply(style, false);
        open.splice(open.lastIndexOf(d.close), 1);
        i += d.close.length;
        matched = true;
        break;
      }
      if (!at(d.open, i) || open.includes(d.close)) continue;
      if (d.flanking && isSpace(i + d.open.length)) break;
      if (d.open === '_' && isWordChar(i - 1)) break;
      const end = find(d.close, i + d.open.length);
      if (end === null || end <= i + d.open.length) break;
      if (d.flanking && isSpace(end - 1)) break;
      flush();
      d.apply(style, true);
      open.push(d.close);
      i += d.open.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += c;
    i += 1;
  }
  flush();
  return merged(out);
}

/** `[label](target)` starting at `from` (the `[`): label, target and the index after `)`. */
function linkParts(chars: string[], from: number): [string, string, number] | null {
  if (from >= chars.length || chars[from] !== '[') return null;
  let depth = 0;
  let j = from;
  while (j < chars.length) {
    if (chars[j] === '\\') { j += 2; continue; }
    if (chars[j] === '[') depth += 1;
    if (chars[j] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  if (!(j + 1 < chars.length && chars[j] === ']' && chars[j + 1] === '(')) return null;
  const close = chars.indexOf(')', j + 2);
  if (close === -1) return null;
  const target = chars.slice(j + 2, close).join('').replace(EDGE_SPACE, '');
  if (target === '' || target.includes(' ')) return null;
  return [chars.slice(from + 1, j).join(''), target, close + 1];
}

function merged(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (isText(inline) && inline.text === '') continue;
    const last = out[out.length - 1];
    if (isText(inline) && last && isText(last) && sameStyle(last.style, inline.style)) {
      out[out.length - 1] = { text: last.text + inline.text, style: last.style };
    } else {
      out.push(inline);
    }
  }
  return out;
}

// MARK: serialize

export function serialize(paragraphs: Paragraph[]): string {
  const lines: string[] = [];
  let numbers = new Map<number, number>();
  let index = 0;
  while (index < paragraphs.length) {
    const block = paragraphs[index].block;
    if (block.kind === 'mono') {
      lines.push('```');
      while (index < paragraphs.length && paragraphs[index].block.kind === 'mono') {
        lines.push(plainText(paragraphs[index].inlines));
        index += 1;
      }
      lines.push('```');
      numbers = new Map();
      continue;
    }
    if (block.kind === 'tableRow') {
      let first = true;
      while (index < paragraphs.length && paragraphs[index].block.kind === 'tableRow') {
        const cells = cellsOf(paragraphs[index].inlines).map((cell) => inlineMarkdown(cell).replaceAll('|', '\\|'));
        lines.push('| ' + cells.join(' | ') + ' |');
        if (first) lines.push('|' + ' --- |'.repeat(Math.max(1, cells.length)));
        first = false;
        index += 1;
      }
      numbers = new Map();
      continue;
    }
    const content = inlineMarkdown(paragraphs[index].inlines);
    if (block.kind === 'text') {
      numbers = new Map();
      const line =
        block.style === 'title' ? (content === '' ? '' : '# ' + content)
        : block.style === 'heading' ? (content === '' ? '##' : '## ' + content)
        : block.style === 'subheading' ? (content === '' ? '###' : '### ' + content)
        : escapedLineStart(content);
      lines.push(block.quoted ? (line === '' ? '>' : '> ' + line) : line);
    } else {
      for (const key of [...numbers.keys()]) if (key > block.indent) numbers.delete(key);
      let mark: string;
      if (block.list === 'number') {
        const n = (numbers.get(block.indent) ?? 0) + 1;
        numbers.set(block.indent, n);
        mark = `${n}. `;
      } else {
        mark = { bullet: '* ', dash: '- ', unchecked: '- [ ] ', checked: '- [x] ' }[block.list];
      }
      const line = '    '.repeat(block.indent) + (content === '' ? mark.slice(0, -1) : mark + content);
      lines.push(block.quoted ? '> ' + line : line);
    }
    index += 1;
  }
  // The first text is Body, not the title: one empty line first, which parse takes back out.
  const head = paragraphs[firstWithText(paragraphs)];
  if (head && isPlainBody(head)) lines.unshift('');
  return lines.join('\n');
}

export function plainText(inlines: Inline[]): string {
  return inlines.map((i) => (isText(i) ? i.text : `[${i.attachment.name}]`)).join('');
}

/** A table row's cells; tabs separate them in the text. */
export function cellsOf(inlines: Inline[]): Inline[][] {
  const cells: Inline[][] = [[]];
  for (const inline of inlines) {
    if (!isText(inline)) {
      cells[cells.length - 1].push(inline);
      continue;
    }
    inline.text.split('\t').forEach((part, n) => {
      if (n > 0) cells.push([]);
      if (part !== '') cells[cells.length - 1].push({ text: part, style: inline.style });
    });
  }
  return cells;
}

function escapedLineStart(content: string): string {
  const lead = /^ */.exec(content)![0];
  const rest = content.slice(lead.length);
  if (rest.startsWith('#') || rest.startsWith('>') || rest.startsWith('- ') || rest === '-' || rest.startsWith('+ ') || rest.startsWith('```') || rest.startsWith('|')) {
    return lead + '\\' + rest;
  }
  const digits = /^[0-9]*/.exec(rest)![0];
  if (digits !== '') {
    const after = rest.slice(digits.length);
    if (after.startsWith('. ') || after.startsWith(') ') || after === '.' || after === ')') return lead + digits + '\\' + after;
  }
  return content;
}

/** One run of text with one style, before its marks are written. */
type Piece = { text: string; style: InlineStyle; attachment?: AttachmentRef; following: string };

export function inlineMarkdown(inlines: Inline[]): string {
  const pieces: Piece[] = [];
  for (const inline of merged(inlines)) {
    if (isText(inline)) pieces.push(...splitWhitespace(inline.text, inline.style));
    else pieces.push({ text: '', style: plain(), attachment: inline.attachment, following: '' });
  }
  let after = '';
  for (let index = pieces.length - 1; index >= 0; index--) {
    pieces[index].following = after;
    after = pieces[index].text + after;
  }
  let out = '';
  let start = 0;
  while (start < pieces.length) {
    let end = start + 1;
    while (end < pieces.length && pieces[end].style.link === pieces[start].style.link && !pieces[end].attachment && !pieces[start].attachment) end += 1;
    const group = pieces.slice(start, end);
    const link = group[0].style.link;
    if (link !== undefined) {
      out += '[' + markedText(group, true) + '](' + link.replaceAll(' ', '%20').replaceAll(')', '%29') + ')';
    } else {
      out += markedText(group, false);
    }
    start = end;
  }
  return out;
}

const FLANKING = BOLD | ITALIC | STRIKE;

/** Whitespace at either end of a `**`-style mark would stop it parsing as one, so it moves outside. */
function splitWhitespace(text: string, style: InlineStyle): Piece[] {
  if (!((style.marks & FLANKING) !== 0 || style.highlight !== undefined) || (style.marks & CODE) !== 0) {
    return [{ text, style, following: '' }];
  }
  const chars = Array.from(text);
  let lead = 0;
  while (lead < chars.length && WHITESPACE.test(chars[lead])) lead += 1;
  let trail = 0;
  while (trail < chars.length - lead && WHITESPACE.test(chars[chars.length - 1 - trail])) trail += 1;
  const outside: InlineStyle = { marks: style.marks & ~FLANKING, link: style.link };
  const pieces: Piece[] = [];
  if (lead > 0) pieces.push({ text: chars.slice(0, lead).join(''), style: outside, following: '' });
  if (chars.length - lead - trail > 0) pieces.push({ text: chars.slice(lead, chars.length - trail).join(''), style, following: '' });
  if (trail > 0) pieces.push({ text: chars.slice(chars.length - trail).join(''), style: outside, following: '' });
  return pieces;
}

type Mark = 'bold' | 'italic' | 'underline' | 'strike' | `highlight:${Highlight}`;

function openOf(mark: Mark): string {
  switch (mark) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'underline': return '<u>';
    case 'strike': return '~~';
    case 'highlight:purple': return '==';
    default: return `<mark data-color="${mark.slice('highlight:'.length)}">`;
  }
}

function closeOf(mark: Mark): string {
  switch (mark) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'underline': return '</u>';
    case 'strike': return '~~';
    case 'highlight:purple': return '==';
    default: return '</mark>';
  }
}

function marksOf(style: InlineStyle): Mark[] {
  const out: Mark[] = [];
  if (style.highlight) out.push(`highlight:${style.highlight}`);
  if (style.marks & UNDERLINE) out.push('underline');
  if (style.marks & STRIKE) out.push('strike');
  if (style.marks & BOLD) out.push('bold');
  if (style.marks & ITALIC) out.push('italic');
  return out;
}

/** Marks open and close as a stack, so `**a *b* c**` nests instead of reopening at every run. */
function markedText(pieces: Piece[], inLink: boolean): string {
  let out = '';
  const stack: Mark[] = [];
  for (const piece of pieces) {
    if (piece.attachment) {
      while (stack.length) out += closeOf(stack.pop()!);
      out += '![' + piece.attachment.name.replaceAll(']', '') + '](' + ATTACHMENT + piece.attachment.file + ')';
      continue;
    }
    const wanted = marksOf(piece.style);
    let keep = 0;
    while (keep < stack.length && wanted.includes(stack[keep])) keep += 1;
    while (stack.length > keep) out += closeOf(stack.pop()!);
    for (const mark of wanted) {
      if (!stack.includes(mark)) {
        out += openOf(mark);
        stack.push(mark);
      }
    }
    if (piece.style.marks & CODE) {
      const ticks = piece.text.includes('`') ? '``' : '`';
      const pad = ticks === '``' ? ' ' : '';
      out += ticks + pad + piece.text + pad + ticks;
    } else {
      out += escaped(piece.text, inLink, piece.following);
    }
  }
  while (stack.length) out += closeOf(stack.pop()!);
  return out;
}

/** Backslashes for every character that would otherwise read as Markdown. `~` and `=` at either end could join a
 * neighbouring `~~` or `==`. */
function escaped(text: string, inLink: boolean, following: string): string {
  const chars = Array.from(text);
  const word = (c: string) => LETTER_OR_NUMBER.test(c);
  let out = '';
  chars.forEach((c, i) => {
    const prev = i > 0 ? chars[i - 1] : '~';
    const next = i + 1 < chars.length ? chars[i + 1] : '~';
    if (c === '\\' || c === '*' || c === '`') out += '\\' + c;
    else if (c === '_' && !(word(prev) && word(next))) out += '\\_';
    else if ((c === '~' && (prev === '~' || next === '~')) || (c === '=' && (prev === '=' || next === '=' || i === 0 || i === chars.length - 1))) out += '\\' + c;
    else if ((c === '[' || c === ']') && inLink) out += '\\' + c;
    else if (c === '<' && /^<\/?(u>|mark)/.test(chars.slice(i).join(''))) out += '\\<';
    else if (c === '[' && (chars.slice(i).join('') + following).includes('](')) out += '\\[';
    else if (c === '!' && next === '[') out += '\\!';
    else out += c;
  });
  return out;
}

// MARK: document operations

const isChecklist = (p: Paragraph) => p.block.kind === 'list' && (p.block.list === 'checked' || p.block.list === 'unchecked');
const isChecked = (p: Paragraph) => p.block.kind === 'list' && p.block.list === 'checked';

/** Within each run of checklist items, the checked ones go below the rest, in their order. */
export function moveCheckedToBottom(paragraphs: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  let index = 0;
  while (index < paragraphs.length) {
    if (!isChecklist(paragraphs[index])) {
      out.push(paragraphs[index]);
      index += 1;
      continue;
    }
    const run: Paragraph[] = [];
    while (index < paragraphs.length && isChecklist(paragraphs[index])) run.push(paragraphs[index++]);
    out.push(...run.filter((p) => !isChecked(p)), ...run.filter(isChecked));
  }
  return out;
}

export function uncheckAll(paragraphs: Paragraph[]): Paragraph[] {
  return paragraphs.map((p) => (isChecked(p) ? { ...p, block: { ...p.block, list: 'unchecked' } as Block } : p));
}

// MARK: Tiptap documents

const LIST_NODE = { bullet: 'bulletList', dash: 'bulletList', number: 'orderedList', unchecked: 'taskList', checked: 'taskList' } as const;
const LEVEL: Record<TextStyle, number> = { title: 1, heading: 2, subheading: 3, body: 0 };

type ListLine = { list: ListKind; indent: number; inlines: Inline[] };

/** Paragraphs to the Tiptap document the editor loads. */
export function toDoc(paragraphs: Paragraph[]): JSONContent {
  const content = blocks(paragraphs);
  return { type: 'doc', content: content.length ? content : [{ type: 'heading', attrs: { level: 1 } }] };
}

function blocks(paragraphs: Paragraph[]): JSONContent[] {
  const out: JSONContent[] = [];
  let i = 0;
  const run = (test: (b: Block) => boolean) => {
    const start = i;
    while (i < paragraphs.length && test(paragraphs[i].block)) i += 1;
    return paragraphs.slice(start, i);
  };
  while (i < paragraphs.length) {
    const block = paragraphs[i].block;
    if (block.kind === 'mono') {
      const text = run((b) => b.kind === 'mono').map((p) => plainText(p.inlines)).join('\n');
      out.push({ type: 'codeBlock', content: text ? [{ type: 'text', text }] : undefined });
    } else if (block.kind === 'tableRow') {
      out.push(table(run((b) => b.kind === 'tableRow')));
    } else if (block.quoted) {
      const quoted = run((b) => (b.kind === 'text' || b.kind === 'list') && b.quoted);
      out.push({ type: 'blockquote', content: blocks(quoted.map((p) => ({ ...p, block: { ...p.block, quoted: false } as Block }))) });
    } else if (block.kind === 'list') {
      const lines = run((b) => b.kind === 'list' && !b.quoted).map((p) => {
        const b = p.block as Extract<Block, { kind: 'list' }>;
        return { list: b.list, indent: b.indent, inlines: p.inlines };
      });
      out.push(...lists(lines, 0));
    } else {
      const content = inlineNodes(paragraphs[i].inlines);
      out.push(block.style === 'body' ? { type: 'paragraph', content } : { type: 'heading', attrs: { level: LEVEL[block.style] }, content });
      i += 1;
    }
  }
  return out;
}

/** Lines at `level` become items of one list per run of the same kind; deeper lines nest under the item above. A line
 * deeper than any parent is taken as one at `level`. */
function lists(lines: ListLine[], level: number): JSONContent[] {
  const out: JSONContent[] = [];
  let numbers = 0;
  let i = 0;
  while (i < lines.length) {
    const kind = lines[i].list;
    const type = LIST_NODE[kind];
    const list: JSONContent = { type, content: [] };
    if (type === 'bulletList') list.attrs = { dashed: kind === 'dash' };
    if (type === 'orderedList') list.attrs = { start: numbers + 1 };
    while (i < lines.length && LIST_NODE[lines[i].list] === type && (type !== 'bulletList' || (lines[i].list === 'dash') === (kind === 'dash'))) {
      const line = lines[i];
      i += 1;
      const children: ListLine[] = [];
      while (i < lines.length && lines[i].indent > level) children.push(lines[i++]);
      if (line.list === 'number') numbers += 1;
      const content: JSONContent[] = [{ type: 'paragraph', content: inlineNodes(line.inlines) }, ...lists(children, level + 1)];
      list.content!.push(type === 'taskList' ? { type: 'taskItem', attrs: { checked: line.list === 'checked' }, content } : { type: 'listItem', content });
    }
    out.push(list);
  }
  return out;
}

function table(rows: Paragraph[]): JSONContent {
  return {
    type: 'table',
    content: rows.map((row, r) => ({
      type: 'tableRow',
      content: cellsOf(row.inlines).map((cell) => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: inlineNodes(cell) }] })),
    })),
  };
}

function inlineNodes(inlines: Inline[]): JSONContent[] | undefined {
  const out = merged(inlines).map((inline): JSONContent => {
    if (!isText(inline)) return { type: 'attachment', attrs: { ...inline.attachment } };
    const marks: JSONContent['marks'] = [];
    const { style } = inline;
    if (style.link !== undefined) marks.push({ type: 'link', attrs: { href: style.link } });
    if (style.marks & BOLD) marks.push({ type: 'bold' });
    if (style.marks & ITALIC) marks.push({ type: 'italic' });
    if (style.marks & UNDERLINE) marks.push({ type: 'underline' });
    if (style.marks & STRIKE) marks.push({ type: 'strike' });
    if (style.marks & CODE) marks.push({ type: 'code' });
    if (style.highlight) marks.push({ type: 'highlight', attrs: { color: style.highlight } });
    return marks.length ? { type: 'text', text: inline.text, marks } : { type: 'text', text: inline.text };
  });
  return out.length ? out : undefined;
}

/** The editor's document back to paragraphs, one per line. */
export function fromDoc(doc: JSONContent): Paragraph[] {
  const out: Paragraph[] = [];
  for (const node of doc.content ?? []) collect(node, false, out);
  return out;
}

function collect(node: JSONContent, quoted: boolean, out: Paragraph[]) {
  switch (node.type) {
    case 'paragraph':
      out.push({ block: body(quoted), inlines: inlinesOf(node) });
      return;
    case 'heading': {
      const level = node.attrs?.level ?? 1;
      out.push({ block: { kind: 'text', style: level === 1 ? 'title' : level === 2 ? 'heading' : 'subheading', quoted }, inlines: inlinesOf(node) });
      return;
    }
    case 'codeBlock':
      for (const line of textOf(node).split('\n')) out.push({ block: { kind: 'mono' }, inlines: line ? [{ text: line, style: plain() }] : [] });
      return;
    case 'blockquote':
      for (const child of node.content ?? []) collect(child, true, out);
      return;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      collectList(node, 0, quoted, out);
      return;
    case 'table':
      (node.content ?? []).forEach((row, r) => {
        const inlines: Inline[] = [];
        (row.content ?? []).forEach((cell, n) => {
          if (n > 0) inlines.push({ text: '\t', style: plain() });
          (cell.content ?? []).forEach((p, k) => {
            if (k > 0) inlines.push({ text: ' ', style: plain() });
            inlines.push(...inlinesOf(p).map((i) => (isText(i) ? { text: i.text.replaceAll('\t', ' '), style: i.style } : i)));
          });
        });
        out.push({ block: { kind: 'tableRow', header: r === 0 }, inlines: merged(inlines) });
      });
      return;
  }
}

function collectList(list: JSONContent, indent: number, quoted: boolean, out: Paragraph[]) {
  for (const item of list.content ?? []) {
    const kind: ListKind =
      list.type === 'taskList' ? (item.attrs?.checked ? 'checked' : 'unchecked')
      : list.type === 'orderedList' ? 'number'
      : list.attrs?.dashed ? 'dash' : 'bullet';
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        collectList(child, indent + 1, quoted, out);
      } else {
        out.push({ block: { kind: 'list', list: kind, indent: Math.min(MAX_INDENT, indent), quoted }, inlines: inlinesOf(child) });
      }
    }
  }
}

function textOf(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(textOf).join('');
}

function inlinesOf(node: JSONContent): Inline[] {
  const out: Inline[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'attachment') {
      out.push({ attachment: { name: child.attrs?.name ?? '', file: child.attrs?.file ?? '' } });
    } else if (child.type === 'text' && child.text) {
      const style = plain();
      for (const mark of child.marks ?? []) {
        if (mark.type === 'bold') style.marks |= BOLD;
        else if (mark.type === 'italic') style.marks |= ITALIC;
        else if (mark.type === 'underline') style.marks |= UNDERLINE;
        else if (mark.type === 'strike') style.marks |= STRIKE;
        else if (mark.type === 'code') style.marks |= CODE;
        else if (mark.type === 'highlight') style.highlight = HIGHLIGHTS.includes(mark.attrs?.color) ? mark.attrs?.color : 'purple';
        else if (mark.type === 'link' && mark.attrs?.href) style.link = mark.attrs.href;
      }
      out.push({ text: child.text, style });
    }
  }
  return merged(out);
}

// MARK: entry points

export const markdownToDoc = (markdown: string): JSONContent => toDoc(parse(markdown));
export const docToMarkdown = (doc: JSONContent): string => serialize(fromDoc(doc));
/** What the editor would save for this Markdown, for comparing an agent's body with the editor's. */
export const normalize = (markdown: string): string => serialize(parse(markdown));
