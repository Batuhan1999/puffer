// Checks the Tiptap editor's Markdown (src/ui/editor/markdown.ts) on Node 24: the same corpus and random documents as
// main.swift, byte equality with the native editor's NoteMarkdown (through the `normalize` binary, argv[2]), and every
// document through the real Tiptap schema (schemaExtensions) and back.
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.')) throw error;
      return next(specifier + '.ts', context);
    }
  },
});

const md = await import('../../src/ui/editor/markdown.ts');
const { schemaExtensions } = await import('../../src/ui/editor/extensions/schema.ts');
const { getSchema } = await import('@tiptap/core');

const normalizeBinary = process.argv[2];
const schema = getSchema(schemaExtensions());
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) {
    failures += 1;
    if (failures <= 25) console.log(`FAIL ${label} ${detail}`);
  }
};
const show = (s) => JSON.stringify(s);

const sample = [
  '# Groceries',
  'Plain **bold** and *italic* and _under_ and <u>underlined</u> ~~gone~~ ==marked== <mark data-color="mint">mint</mark>',
  '- [ ] milk',
  '- [x] eggs',
  '    * nested bullet',
  '1. one',
  '2. two',
  '> quoted line',
  '[site](https://example.com) and `code` and snake_case and 2 * 3 * 4',
  '![Photo](attachment:ab12cd34.jpg)',
  '| a | b |',
  '| --- | --- |',
  '| 1 | **2** |',
  '```',
  'let x = 1',
  '```',
].join('\n');

const corpus = [
  sample, 'Title\n\nBody text\n', '', 'just one line', '* a\n  * b\n    * c\n* d', '1) x\n2) y', 'a\\*b *c* **d *e* f**', '***both***',
  'Text with trailing  \n', '**bold **x', '| x |\n|---|\n| y |\n', '> - [ ] quoted task', '#tag and # heading?\n## Heading\n### Sub\n#### Deep',
  '[Groceries](puffer://note/abc) and #errand', '# T\n|  |  |\n| --- | --- |\n|  |  |\n', '# T\n*\n-\n1.\n- [ ]\n- [x]',
  '# Plan\n- [ ] a\n    - [x] b\n        1. c\n    - d\n- [ ] e', '> # quoted title\n> body\n> - item', '**`bold code`** and ``a`b``',
  '# T\nline one\nline two\n\n\nafter blanks', '# Groceries\nPlain line one\nPlain line two\n- [ ] milk\nafter list',
  // The editor's own features: colored highlights, attachments in lists and tables, note links, tags beside markup.
  '# Colors\n<mark data-color="pink">pink</mark> <mark data-color="orange">**bold orange**</mark> <mark data-color="blue">*blue*</mark> ==purple==',
  '# Files\n- [ ] ![Scan](attachment:scan1.pdf)\n- ![Drawing](attachment:d.drawing)\n| photo | note |\n| --- | --- |\n| ![P](attachment:p.jpg) | [Trip](puffer://note/x1) |',
  '# Tags\n#home and #work-2026, not a#b or http://x.y/#z, `#code`, **#bold** and ## not a heading',
  '# Title\n## Section\ntext\n### Sub\nmore\n## Next\n- [x] done <u>under</u> ~~strike~~',
];

// Paragraph model checks, as main.swift does them.
const doc = md.parse(sample);
const kinds = doc.map((p) => (p.block.kind === 'list' ? `${p.block.list}@${p.block.indent}` : p.block.kind === 'text' ? `${p.block.style}${p.block.quoted ? '>' : ''}` : p.block.kind));
check(show(kinds) === show(['title', 'body', 'unchecked@0', 'checked@0', 'bullet@1', 'number@0', 'number@0', 'body>', 'body', 'body', 'tableRow', 'tableRow', 'mono']), 'sample blocks', show(kinds));
check(show(doc[1].inlines.map((i) => [i.text, i.style.marks, i.style.highlight ?? null])) === show([
  ['Plain ', 0, null], ['bold', md.BOLD, null], [' and ', 0, null], ['italic', md.ITALIC, null], [' and ', 0, null], ['under', md.ITALIC, null],
  [' and ', 0, null], ['underlined', md.UNDERLINE, null], [' ', 0, null], ['gone', md.STRIKE, null], [' ', 0, null], ['marked', 0, 'purple'],
  [' ', 0, null], ['mint', 0, 'mint'],
]), 'inline marks', show(doc[1].inlines));
check(show(doc[9].inlines) === show([{ attachment: { name: 'Photo', file: 'ab12cd34.jpg' } }]), 'attachment');
check(md.parse('plain words', false)[0].block.style === 'body', 'fragment keeps body');
check(md.normalize('') === '', 'empty note stays empty');
// A first line set to Body stays Body: an empty line before it, which the parser takes back out.
const bodyFirst = md.serialize([{ block: { kind: 'text', style: 'body', quoted: false }, inlines: [{ text: 'not a title', style: { marks: 0 } }] }]);
check(bodyFirst === '\nnot a title' && md.parse(bodyFirst)[0].block.style === 'body' && md.parse(bodyFirst).length === 1, 'body first line', show(bodyFirst));
check(md.normalize('just text') === '# just text', 'implicit title');
check(md.normalize('\n\nafter blank') === '\n\nafter blank', 'leading blank keeps body');
check(show(md.parse('[Groceries](puffer://note/abc)')[0].inlines) === show([{ text: 'Groceries', style: { marks: 0, link: 'puffer://note/abc' } }]), 'note link');

const list = md.parse('# L\n- [x] a\n- [ ] b\n- [x] c\n- [ ] d\ntext\n- [x] e\n- [ ] f');
check(md.serialize(md.moveCheckedToBottom(list)) === '# L\n- [ ] b\n- [ ] d\n- [x] a\n- [x] c\ntext\n- [ ] f\n- [x] e', 'move checked', show(md.serialize(md.moveCheckedToBottom(list))));
check(!md.serialize(md.uncheckAll(list)).includes('[x]'), 'uncheck all');

// Random documents, as main.swift builds them.
const alphabet = Array.from('abcXYZ019 *_~=<>[]()`\\#-+|!.:/&"\'é😀');
// Seeded, so a failure reruns: SEED=<n> node tiptap.mjs <normalize>.
const seed = Number(process.env.SEED ?? Date.now() % 1e9);
let state = seed;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = (n) => Math.floor(random() * n);
const pick = (xs) => xs[rand(xs.length)];
const word = () => {
  let s = '';
  for (let n = 1 + rand(8); n > 0; n--) s += pick(alphabet);
  s = s.trim();
  return s === '' ? 'w' : s;
};
const randomStyle = () => {
  let style = { marks: 0 };
  for (const m of [md.BOLD, md.ITALIC, md.UNDERLINE, md.STRIKE]) if (random() < 0.5 && rand(3) === 0) style.marks |= m;
  if (rand(6) === 0) style.highlight = pick(md.HIGHLIGHTS);
  if (rand(8) === 0) style.link = 'https://x.y/' + rand(99);
  if (rand(10) === 0) style = { marks: md.CODE };
  return style;
};
const randomInlines = () => {
  const out = [];
  for (let n = 0, count = 1 + rand(5); n < count; n++) {
    if (n > 0) out.push({ text: ' ', style: { marks: 0 } });
    if (rand(15) === 0) { out.push({ attachment: { name: 'img', file: `f${n}.png` } }); continue; }
    const style = randomStyle();
    let w = word();
    if (style.marks & md.CODE) w = w.replaceAll('`', '') || 'c';
    out.push({ text: w, style });
  }
  return out;
};
const randomDoc = () => {
  const paragraphs = [{ block: { kind: 'text', style: 'title', quoted: false }, inlines: [{ text: 'T' + word(), style: { marks: 0 } }] }];
  for (let n = rand(7); n > 0; n--) {
    const kind = rand(6);
    const last = paragraphs[paragraphs.length - 1].block;
    if (kind === 0) paragraphs.push({ block: { kind: 'text', style: pick(['heading', 'subheading', 'body']), quoted: random() < 0.5 }, inlines: randomInlines() });
    else if (kind === 1) {
      const indent = last.kind === 'list' ? rand(last.indent + 2) : 0;
      paragraphs.push({ block: { kind: 'list', list: pick(['bullet', 'dash', 'number', 'unchecked', 'checked']), indent, quoted: false }, inlines: randomInlines() });
    } else if (kind === 2) paragraphs.push({ block: { kind: 'mono' }, inlines: [{ text: word().replaceAll('`', "'"), style: { marks: 0 } }] });
    else if (kind === 3) paragraphs.push({ block: { kind: 'text', style: 'body', quoted: false }, inlines: [] });
    else paragraphs.push({ block: { kind: 'text', style: 'body', quoted: false }, inlines: randomInlines() });
  }
  return paragraphs;
};
const tidy = (paragraphs) => paragraphs.map((p) => ({ block: p.block, inlines: mergeRuns(p.inlines) }));
const mergeRuns = (inlines) => {
  const out = [];
  for (const i of inlines) {
    if ('text' in i && i.text === '') continue;
    const last = out[out.length - 1];
    const same = last && 'text' in last && 'text' in i && last.style.marks === i.style.marks && last.style.highlight === i.style.highlight && last.style.link === i.style.link;
    if (same) out[out.length - 1] = { text: last.text + i.text, style: last.style };
    else out.push('text' in i ? { text: i.text, style: { marks: i.style.marks, ...(i.style.highlight ? { highlight: i.style.highlight } : {}), ...(i.style.link !== undefined ? { link: i.style.link } : {}) } } : i);
  }
  return out;
};

const ROUNDS = 3000;
const randomMarkdown = [];
let mismatches = 0;
for (let n = 0; n < ROUNDS; n++) {
  const original = tidy(randomDoc());
  const text = md.serialize(original);
  randomMarkdown.push(text);
  const back = tidy(md.parse(text));
  if (show(back) !== show(original)) {
    mismatches += 1;
    if (mismatches <= 3) console.log(`ROUNDTRIP MISMATCH\n${text}\n want ${show(original)}\n got  ${show(back)}`);
  }
}
check(mismatches === 0, 'random round trips', `${mismatches} of ${ROUNDS}`);

// Raw strings no editor wrote: Markdown-ish lines from the same alphabet.
const prefixes = ['', '', '# ', '## ', '### ', '- ', '* ', '1. ', '- [ ] ', '- [x] ', '> ', '    - ', '| ', '```', '\t* '];
const fuzz = [];
for (let n = 0; n < 2000; n++) {
  const lines = [];
  for (let k = rand(6); k >= 0; k--) lines.push(pick(prefixes) + Array.from({ length: rand(4) }, word).join(' '));
  if (rand(5) === 0) lines.splice(1, 0, '| --- | --- |');
  fuzz.push(lines.join('\n'));
}

const inputs = [...corpus, ...randomMarkdown, ...fuzz];
for (const text of inputs) {
  const once = md.normalize(text);
  check(md.normalize(once) === once, 'fixed point', `\n--- md ${show(text)}\n--- once ${show(once)}`);
}

// Without the binary (no Swift, e.g. Linux or CI: `node tiptap.mjs`) the comparison with native is skipped.
if (normalizeBinary) {
  const native = JSON.parse(execFileSync(normalizeBinary, { input: JSON.stringify(inputs), maxBuffer: 1 << 28 }).toString());
  let differs = 0;
  inputs.forEach((text, n) => {
    if (md.normalize(text) !== native[n]) {
      differs += 1;
      if (differs <= 5) console.log(`NATIVE DIFFERS\n--- md ${show(text)}\n--- tiptap ${show(md.normalize(text))}\n--- native ${show(native[n])}`);
    }
  });
  check(differs === 0, 'same Markdown as the native editor', `${differs} of ${inputs.length}`);
} else console.log('No normalize binary: skipped the byte comparison with the native editor');

// A list line deeper than the line above it plus one (possible after a quoted list) has no parent in a tree of lists,
// so the editor moves it up to the deepest level it can nest at. The one place the Tiptap editor changes a note.
const clampOrphans = (paragraphs) => {
  let previous = null;
  return paragraphs.map((p) => {
    if (p.block.kind !== 'list') {
      previous = null;
      return p;
    }
    const sameRun = previous && previous.quoted === p.block.quoted;
    const indent = sameRun ? Math.min(p.block.indent, previous.indent + 1) : 0;
    previous = { quoted: p.block.quoted, indent };
    return { ...p, block: { ...p.block, indent } };
  });
};

// Through the editor's schema: what Tiptap would hold and save.
let schemaDiffers = 0;
let clamped = 0;
for (const text of inputs) {
  let saved;
  try {
    const node = schema.nodeFromJSON(md.markdownToDoc(text));
    node.check();
    saved = md.docToMarkdown(node.toJSON());
  } catch (error) {
    saved = `THROWS ${error.message}`;
  }
  if (saved !== md.normalize(text) && saved === md.serialize(clampOrphans(md.parse(text)))) clamped += 1;
  else if (saved !== md.normalize(text)) {
    schemaDiffers += 1;
    if (schemaDiffers <= 5) console.log(`SCHEMA ROUND TRIP DIFFERS\n--- md ${show(text)}\n--- want ${show(md.normalize(text))}\n--- got  ${show(saved)}`);
  }
}
check(schemaDiffers === 0, 'Markdown -> Tiptap document -> Markdown', `${schemaDiffers} of ${inputs.length}`);

console.log(`${inputs.length} documents (${corpus.length} corpus, ${ROUNDS} random, ${fuzz.length} fuzzed); ${clamped} with an orphan list indent moved up`);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED (SEED=${seed})`);
process.exit(failures === 0 ? 0 : 1);
