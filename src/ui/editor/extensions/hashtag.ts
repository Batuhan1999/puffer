import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** NoteRendering's tag pattern: `#word`, not inside a word, a URL or `##`. */
const TAG = /(?<![\p{L}\p{N}_#/])#[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*/gu;

function tags(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.name === 'codeBlock') return true;
    // One character per inline leaf, so offsets in this string are offsets in the node.
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    for (const match of text.matchAll(TAG)) {
      const from = pos + 1 + match.index;
      decorations.push(Decoration.inline(from, from + match[0].length, { class: 'hashtag' }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** `#tags` in the note's tint. A look, not a mark: the Markdown keeps them as plain text, as agents write them. */
export const Hashtag = Extension.create({
  name: 'hashtag',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('hashtag'),
        state: {
          init: (_, state) => tags(state.doc),
          apply: (tr, old) => (tr.docChanged ? tags(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
