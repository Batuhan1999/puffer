// Measurement only (always exits 0): every document of the tiptap.mjs corpus through Markdown -> HTML -> Markdown with
// src/ui/editor-enriched/markdown.ts, compared with the native-equivalent `normalize` of src/ui/editor/markdown.ts.
// Node measures only this JS conversion. On device the native EnrichedTextInput parses the HTML into attributed text and
// writes HTML back, which can normalize it further (see RoundTrip.tsx for that measurement). Run: node enriched.mjs
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
const en = await import('../../src/ui/editor-enriched/markdown.ts');

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

// Random documents, as main.swift builds them.
const alphabet = Array.from('abcXYZ019 *_~=<>[]()`\\#-+|!.:/&"\'é😀');
// Seeded, so a failure reruns: SEED=<n> node enriched.mjs.
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

// Stubs: every image attachment displays as a 100x100 <img>; other files become links (as the editor does).
const ctx = { attachmentsDir: 'file:///notes/', imageSize: () => ({ width: 100, height: 100 }) };

const features = [
  ['highlight colors', /<mark data-color="(pink|orange|mint|blue)"/],
  ['highlight (purple ==)', /==\S/],
  ['tables', /^\|.*\|?\s*$/m],
  ['nested lists', /^(    |\t| {2,})\s*([-*+]|\d+[.)])( |$)/m],
  ['checklists', /^\s*- \[[ xX]\]/m],
  ['attachments', /!\[[^\]]*\]\(attachment:/],
  ['note links', /\]\(puffer:\/\/note\//],
  ['links', /\[[^\]]*\]\(https?:/],
  ['underline', /<u>/],
  ['code', /`|^```/m],
  ['quotes', /^>/m],
  ['headings', /^#{1,6}( |$)/m],
  ['body-first line', /^\n/],
];
const classify = (text) => {
  const hits = features.filter(([, re]) => re.test(text)).map(([name]) => name);
  return hits.length ? hits : ['plain text only'];
};

// Same note apart from trailing newlines and the bullet character (`*`/`+` written back as `-`).
const loose = (t) => t.replace(/\n+$/, '').replace(/^( *)[*+]( |$)/gm, '$1-$2');
let exact = 0;
let differs = 0;
let throws = 0;
let idempotentOnDiff = 0;
let sameMeaning = 0; // differs byte-wise, but parses back to the same note (normalize(got) === want)
const byFeature = new Map();
const totalByFeature = new Map();
const examples = [];
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const sources = (n) => (n < corpus.length ? 'corpus' : n < corpus.length + ROUNDS ? 'random' : 'fuzz');
const bySource = {};

inputs.forEach((text, n) => {
  const want = md.normalize(text);
  const src = sources(n);
  bySource[src] ??= { exact: 0, differs: 0, throws: 0, total: 0 };
  bySource[src].total += 1;
  const tags = classify(text);
  tags.forEach((t) => bump(totalByFeature, t));
  let got;
  try {
    got = en.htmlToMarkdown(en.markdownToHtml(text, ctx), { implicitTitle: en.hasImplicitTitle(text) });
  } catch (error) {
    throws += 1;
    bySource[src].throws += 1;
    if (examples.length < 40) examples.push({ kind: 'THROWS', text, want, got: String(error.message), tags });
    return;
  }
  if (got === want) {
    exact += 1;
    bySource[src].exact += 1;
    return;
  }
  differs += 1;
  bySource[src].differs += 1;
  const cosmetic = loose(md.normalize(got)) === loose(want);
  if (cosmetic) sameMeaning += 1;
  else tags.forEach((t) => bump(byFeature, t));
  if (md.normalize(got) === got) idempotentOnDiff += 1;
  if (examples.length < 400) examples.push({ kind: cosmetic ? 'COSMETIC' : 'DIFFERS', text, want, got, tags });
});

const pct = (a, b) => (b === 0 ? '0.0%' : ((100 * a) / b).toFixed(1) + '%');
console.log(`Seed ${seed}. ${inputs.length} documents (${corpus.length} corpus, ${ROUNDS} random, ${fuzz.length} fuzzed)`);
console.log(`exact   ${exact} (${pct(exact, inputs.length)})`);
console.log(`differs ${differs} (${pct(differs, inputs.length)})`);
console.log(`throws  ${throws} (${pct(throws, inputs.length)})`);
console.log(`  of the differing: ${sameMeaning} parse back to the same note (cosmetic: implicit title, trailing newline, bullet character), ${differs - sameMeaning} change content (${pct(differs - sameMeaning, inputs.length)})`);
console.log(`differing outputs that are themselves normalized Markdown: ${idempotentOnDiff} of ${differs}`);
for (const [name, s] of Object.entries(bySource)) console.log(`  ${name}: ${s.exact} exact, ${s.differs} differs, ${s.throws} throws of ${s.total}`);
console.log('\nDocuments whose content changes (not cosmetic), by feature present in the source (a document counts under every feature it has):');
for (const [name, count] of [...byFeature].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(24)} ${String(count).padStart(5)} of ${String(totalByFeature.get(name)).padStart(5)} with it (${pct(count, totalByFeature.get(name))})`);
}

// One example per feature, shortest first, then the throws.
const seen = new Set();
console.log('\nExamples (shortest per feature):');
const shown = [...examples].sort((a, b) => (a.kind === 'COSMETIC') - (b.kind === 'COSMETIC') || a.text.length - b.text.length);
for (const e of shown) {
  const key = e.kind + e.tags[0];
  if (seen.has(key) || seen.size >= 14) continue;
  seen.add(key);
  console.log(`--- ${e.kind} [${e.tags.join(', ')}]\n  md   ${show(e.text)}\n  want ${show(e.want)}\n  got  ${show(e.got)}`);
}
console.log('\nNote: Node measures only the JS conversion. The native EnrichedTextInput may normalize the HTML further on device.');
process.exit(0);
