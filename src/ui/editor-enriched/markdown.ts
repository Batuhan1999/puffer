// Spike: Puffer Markdown <-> react-native-enriched-html's HTML dialect. Blocks are line-based like NoteMarkdown in
// modules/puffer-native/ios/Editor/NoteDocument.swift; marked only lexes inline syntax. Node can run this file as is
// (type stripping), so the round-trip measurement exercises the same code the app does.
import type { ChildNode as Node, Element, Text } from 'domhandler';
import { ElementType, parseDocument } from 'htmlparser2';
import { Marked, type Tokens } from 'marked';

export type Highlight = 'purple' | 'pink' | 'orange' | 'mint' | 'blue';
export const HIGHLIGHTS: readonly Highlight[] = ['purple', 'pink', 'orange', 'mint', 'blue'];

export const NOTE_LINK = 'puffer://note/';
export const ATTACHMENT = 'attachment:';
export const TAG_INDICATOR = '#';
export const NOTE_INDICATOR = '@';

export type Context = {
  /** file:///…/Documents/NoteAttachments/<note id>/ */
  attachmentsDir: string;
  /** Display size of an image attachment; non-images and unknown sizes become links. */
  imageSize: (file: string) => { width: number; height: number } | undefined;
};

const IMAGE = /\.(png|jpe?g|gif|heic|webp)$/i;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// MARK: Markdown -> HTML

function inlineLexer(ctx: Context) {
  const marked = new Marked({
    gfm: true,
    extensions: [
      {
        name: 'highlight',
        level: 'inline',
        start: (src: string) => src.indexOf('=='),
        tokenizer(src: string) {
          const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
          if (!m) return undefined;
          return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(token) {
          return `<mark data-color="purple">${this.parser.parseInline(token.tokens ?? [])}</mark>`;
        },
      },
      {
        name: 'tag',
        level: 'inline',
        start: (src: string) => {
          const m = /(^|\s)#[\p{L}\p{N}]/u.exec(src);
          return m ? m.index + m[1].length : undefined;
        },
        tokenizer(src: string) {
          const m = /^#[\p{L}\p{N}][\p{L}\p{N}_-]*/u.exec(src);
          return m ? { type: 'tag', raw: m[0], text: m[0] } : undefined;
        },
        renderer: (token) => `<mention text="${esc(token.text)}" indicator="${TAG_INDICATOR}">${esc(token.text)}</mention>`,
      },
    ],
    renderer: {
      strong({ tokens }) {
        return `<b>${this.parser.parseInline(tokens)}</b>`;
      },
      em({ tokens }) {
        return `<i>${this.parser.parseInline(tokens)}</i>`;
      },
      del({ tokens }) {
        return `<s>${this.parser.parseInline(tokens)}</s>`;
      },
      codespan({ text }) {
        return `<code>${text}</code>`;
      },
      br() {
        return ' ';
      },
      html({ text }) {
        const mark = /^<mark\b[^>]*>$/i.test(text) ? HIGHLIGHTS.find((c) => text.includes(`"${c}"`) || text.includes(`'${c}'`)) ?? 'purple' : null;
        if (mark) return `<mark data-color="${mark}">`;
        if (/^<\/?(u|mark)>$/i.test(text)) return text.toLowerCase();
        return esc(text);
      },
      link({ href, tokens, text }) {
        if (href.startsWith(NOTE_LINK)) {
          const id = href.slice(NOTE_LINK.length);
          return `<mention text="${esc(text)}" indicator="${NOTE_INDICATOR}" id="${esc(id)}">${esc(text)}</mention>`;
        }
        return `<a href="${esc(href)}">${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, text }) {
        if (!href.startsWith(ATTACHMENT)) return esc(text);
        const file = href.slice(ATTACHMENT.length);
        const size = IMAGE.test(file) ? ctx.imageSize(file) : undefined;
        if (!size) return `<a href="${esc(href)}">${esc(text || file)}</a>`;
        const src = `${ctx.attachmentsDir}${encodeURI(file)}#${encodeURIComponent(text)}`;
        return `<img src="${esc(src)}" width="${Math.round(size.width)}" height="${Math.round(size.height)}"/>`;
      },
    },
  });
  return (text: string) => marked.parseInline(text, { async: false }) as string;
}

type Line =
  | { kind: 'p' | 'h1' | 'h2' | 'h3'; html: string }
  | { kind: 'empty' }
  | { kind: 'ul' | 'ol'; html: string }
  | { kind: 'check'; checked: boolean; html: string }
  | { kind: 'quote'; html: string | null }
  | { kind: 'code'; text: string };

/** Whether the first non-empty line is a title without `#`, which htmlToMarkdown needs to write it back the same way. */
export function hasImplicitTitle(markdown: string) {
  const first = markdown.split('\n').find((l) => l.trim() !== '');
  return first !== undefined && !/^#{1,6}( |$)/.test(first) && lineKindIsBody(first);
}

const lineKindIsBody = (line: string) => !/^(> ?|[ \t]*([-*+]( |$)|\d+[.)]( |$))|```)/.test(line);

export function markdownToHtml(markdown: string, ctx: Context): string {
  const inline = inlineLexer(ctx);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const out: Line[] = [];
  let titled = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/^ +/, '');
    if (trimmed.startsWith('```')) {
      for (i++; i < lines.length && !lines[i].replace(/^ +/, '').startsWith('```'); i++) out.push({ kind: 'code', text: lines[i] });
      continue;
    }
    const line = lineBlock(raw, inline);
    // The first non-empty line is the note's title whether or not it starts with `#` (NoteMarkdown's implicit title).
    if (!titled && line.kind !== 'empty') {
      titled = true;
      if (line.kind === 'p') line.kind = 'h1';
    }
    out.push(line);
  }
  return `<html>${render(out)}\n</html>`;
}

function lineBlock(raw: string, inline: (s: string) => string): Line {
  if (raw.trim() === '') return { kind: 'empty' };
  if (/^>( |$)/.test(raw)) {
    const rest = raw.replace(/^> ?/, '');
    return { kind: 'quote', html: rest.trim() ? inline(rest) : null };
  }
  // Enriched has no nesting: indented items join the top-level list (a measured loss).
  const s = raw.replace(/^[ \t]+/, '');
  const check = /^- \[( |x|X)\](?: (.*))?$/.exec(s);
  if (check) return { kind: 'check', checked: check[1] !== ' ', html: inline(check[2] ?? '') };
  const bullet = /^[-*+](?: (.*))?$/.exec(s);
  if (bullet) return { kind: 'ul', html: inline(bullet[1] ?? '') };
  const number = /^\d+[.)](?: (.*))?$/.exec(s);
  if (number) return { kind: 'ol', html: inline(number[1] ?? '') };
  const heading = /^(#{1,6})(?: (.*))?$/.exec(raw);
  if (heading) {
    const n = heading[1].length;
    return { kind: n === 1 ? 'h1' : n === 2 ? 'h2' : 'h3', html: inline(heading[2] ?? '') };
  }
  // A table row stays as its pipe text: enriched has no tables (a measured loss, but the text round-trips).
  return { kind: 'p', html: inline(raw) };
}

function render(lines: Line[]): string {
  let html = '';
  let open: 'ul' | 'ol' | 'check' | 'quote' | 'code' | null = null;
  const close = () => {
    if (open === 'ul' || open === 'check') html += '\n</ul>';
    if (open === 'ol') html += '\n</ol>';
    if (open === 'quote') html += '\n</blockquote>';
    if (open === 'code') html += '\n</codeblock>';
    open = null;
  };
  for (const line of lines) {
    const group = line.kind === 'ul' || line.kind === 'ol' || line.kind === 'check' || line.kind === 'quote' || line.kind === 'code' ? line.kind : null;
    if (open !== group) {
      close();
      if (group === 'ul') html += '\n<ul>';
      if (group === 'ol') html += '\n<ol>';
      if (group === 'check') html += '\n<ul data-type="checkbox">';
      if (group === 'quote') html += '\n<blockquote>';
      if (group === 'code') html += '\n<codeblock>';
      open = group;
    }
    switch (line.kind) {
      case 'empty':
        html += '\n<br>';
        break;
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
        html += line.html ? `\n<${line.kind}>${line.html}</${line.kind}>` : '\n<br>';
        break;
      case 'ul':
      case 'ol':
        html += `\n<li>${line.html}</li>`;
        break;
      case 'check':
        html += `\n<li${line.checked ? ' checked' : ''}>${line.html}</li>`;
        break;
      case 'quote':
        html += line.html === null ? '\n<br>' : `\n<p>${line.html}</p>`;
        break;
      case 'code':
        html += line.text ? `\n<p>${esc(line.text)}</p>` : '\n<br>';
        break;
    }
  }
  close();
  return html;
}

// MARK: HTML -> Markdown

const isElement = (n: Node): n is Element => ElementType.isTag(n);
const isText = (n: Node): n is Text => n.type === ElementType.Text;

type Style = { b?: true; i?: true; u?: true; s?: true; code?: true; mark?: Highlight; link?: string };
type Run = { text: string; style: Style; image?: string; verbatim?: true };

function runs(nodes: readonly Node[], style: Style, out: Run[]) {
  for (const n of nodes) {
    if (isText(n)) {
      out.push({ text: n.data, style });
      continue;
    }
    if (!isElement(n)) continue;
    const a = n.attribs;
    switch (n.name) {
      case 'b':
      case 'i':
      case 'u':
      case 's':
      case 'code':
        runs(n.children, { ...style, [n.name]: true }, out);
        break;
      case 'mark':
        runs(n.children, { ...style, mark: (HIGHLIGHTS as readonly string[]).includes(a['data-color']) ? (a['data-color'] as Highlight) : 'purple' }, out);
        break;
      case 'a':
        if (a.href?.startsWith(ATTACHMENT)) out.push({ text: '', style, image: `![${textOf(n.children)}](${a.href})` });
        else runs(n.children, { ...style, link: a.href }, out);
        break;
      case 'mention':
        if (a.indicator === NOTE_INDICATOR) runs(n.children, { ...style, link: NOTE_LINK + (a.id ?? '') }, out);
        else out.push({ text: textOf(n.children), style, verbatim: true });
        break;
      case 'img': {
        const src = a.src ?? '';
        const [path, name = ''] = src.split('#');
        const file = decodeURI(path.slice(path.lastIndexOf('/') + 1));
        out.push({ text: '', style, image: `![${decodeURIComponent(name)}](${ATTACHMENT}${file})` });
        break;
      }
      case 'br':
        out.push({ text: ' ', style });
        break;
      default:
        runs(n.children, style, out);
    }
  }
}

function textOf(nodes: readonly Node[]): string {
  return nodes.map((n) => (isText(n) ? n.data : isElement(n) ? textOf(n.children) : '')).join('');
}

type Mark = 'mark' | 'u' | 's' | 'b' | 'i';
const ORDER: readonly Mark[] = ['mark', 'u', 's', 'b', 'i'];

function open(m: Mark, style: Style) {
  if (m === 'mark') return style.mark === 'purple' ? '==' : `<mark data-color="${style.mark}">`;
  return { u: '<u>', s: '~~', b: '**', i: '*' }[m];
}

function close(m: Mark, color: Highlight | undefined) {
  if (m === 'mark') return color === 'purple' ? '==' : '</mark>';
  return { u: '</u>', s: '~~', b: '**', i: '*' }[m];
}

/** NoteMarkdown's `escaped`, without its lookahead for `](`. */
function escapeText(text: string, inLink: boolean) {
  let out = '';
  const word = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : '~';
    const next = i + 1 < text.length ? text[i + 1] : '~';
    if (c === '\\' || c === '*' || c === '`') out += '\\' + c;
    else if (c === '_' && !(word(prev) && word(next))) out += '\\_';
    else if ((c === '~' && (prev === '~' || next === '~')) || (c === '=' && (prev === '=' || next === '=' || i === 0 || i === text.length - 1))) out += '\\' + c;
    else if ((c === '[' || c === ']') && inLink) out += '\\' + c;
    else if (c === '<' && /^<\/?(u>|mark)/.test(text.slice(i))) out += '\\<';
    else if (c === '!' && next === '[') out += '\\!';
    else out += c;
  }
  return out;
}

function inlineMarkdown(nodes: readonly Node[]): string {
  const list: Run[] = [];
  runs(nodes, {}, list);
  // Whitespace at either end of a `**`-style mark would stop it parsing as one, so it moves outside.
  const pieces: Run[] = [];
  for (const r of list) {
    if (r.image || r.verbatim || r.style.code || !(r.style.b || r.style.i || r.style.s || r.style.mark)) {
      pieces.push(r);
      continue;
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!;
    const outside: Style = { ...r.style, b: undefined, i: undefined, s: undefined, mark: undefined };
    if (m[1]) pieces.push({ text: m[1], style: outside });
    if (m[2]) pieces.push({ text: m[2], style: r.style });
    if (m[3]) pieces.push({ text: m[3], style: outside });
  }
  let out = '';
  for (let start = 0; start < pieces.length; ) {
    let end = start + 1;
    while (end < pieces.length && pieces[end].style.link === pieces[start].style.link) end++;
    const group = pieces.slice(start, end);
    const link = group[0].style.link;
    out += link ? `[${marked(group, true)}](${link.replace(/ /g, '%20').replace(/\)/g, '%29')})` : marked(group, false);
    start = end;
  }
  return out;
}

/** Marks open and close as a stack, in NoteMarkdown's order, so `**a *b* c**` nests instead of reopening. */
function marked(pieces: Run[], inLink: boolean) {
  let out = '';
  const stack: { m: Mark; color?: Highlight }[] = [];
  const has = (style: Style, m: Mark) => (m === 'mark' ? style.mark !== undefined : !!style[m]);
  for (const piece of pieces) {
    if (piece.image) {
      while (stack.length) {
        const top = stack.pop()!;
        out += close(top.m, top.color);
      }
      out += piece.image;
      continue;
    }
    const wanted = ORDER.filter((m) => has(piece.style, m));
    let keep = 0;
    while (keep < stack.length && wanted.includes(stack[keep].m) && (stack[keep].m !== 'mark' || stack[keep].color === piece.style.mark)) keep++;
    while (stack.length > keep) {
      const top = stack.pop()!;
      out += close(top.m, top.color);
    }
    for (const m of wanted) {
      if (stack.some((s) => s.m === m)) continue;
      out += open(m, piece.style);
      stack.push({ m, color: piece.style.mark });
    }
    if (piece.style.code) {
      const ticks = piece.text.includes('`') ? '``' : '`';
      const pad = ticks === '``' ? ' ' : '';
      out += ticks + pad + piece.text + pad + ticks;
    } else out += piece.verbatim ? piece.text : escapeText(piece.text, inLink);
  }
  while (stack.length) {
    const top = stack.pop()!;
    out += close(top.m, top.color);
  }
  return out;
}

/** NoteMarkdown's `escapedLineStart`, except a `|` row stays a table row. */
function escapeLineStart(content: string) {
  const lead = /^ */.exec(content)![0];
  const rest = content.slice(lead.length);
  if (/^(#|>|- |-$|\+ |```)/.test(rest)) return lead + '\\' + rest;
  const digits = /^\d+/.exec(rest);
  if (digits && /^([.)] |[.)]$)/.test(rest.slice(digits[0].length))) return lead + digits[0] + '\\' + rest.slice(digits[0].length);
  return content;
}

/** `implicitTitle`: the note's first line had no `#`, so a leading h1 is written back without one. */
export function htmlToMarkdown(html: string, { implicitTitle = false } = {}): string {
  const doc = parseDocument(html);
  const root = doc.children.find((n): n is Element => isElement(n) && n.name === 'html');
  const blocks = (root ?? doc).children;
  const lines: string[] = [];
  for (const n of blocks) {
    if (!isElement(n)) continue;
    const items = n.children.filter(isElement);
    switch (n.name) {
      case 'br':
        lines.push('');
        break;
      case 'p':
        lines.push(escapeLineStart(inlineMarkdown(n.children)));
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const content = inlineMarkdown(n.children);
        const hashes = n.name === 'h1' ? '#' : n.name === 'h2' ? '##' : '###';
        const bare = implicitTitle && n.name === 'h1' && lines.every((l) => l === '');
        lines.push(bare ? escapeLineStart(content) : content ? `${hashes} ${content}` : n.name === 'h1' ? '' : hashes);
        break;
      }
      case 'ul': {
        const checkbox = n.attribs['data-type'] === 'checkbox';
        for (const li of items) {
          const content = inlineMarkdown(li.children);
          const mark = checkbox ? ('checked' in li.attribs ? '- [x]' : '- [ ]') : '-';
          lines.push(content ? `${mark} ${content}` : mark);
        }
        break;
      }
      case 'ol':
        items.forEach((li, k) => {
          const content = inlineMarkdown(li.children);
          lines.push(content ? `${k + 1}. ${content}` : `${k + 1}.`);
        });
        break;
      case 'blockquote':
        for (const p of items) {
          const content = p.name === 'br' ? '' : escapeLineStart(inlineMarkdown(p.children));
          lines.push(content ? `> ${content}` : '>');
        }
        break;
      case 'codeblock':
        lines.push('```');
        for (const p of items) lines.push(p.name === 'br' ? '' : textOf(p.children));
        lines.push('```');
        break;
    }
  }
  return lines.join('\n');
}
