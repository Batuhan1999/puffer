import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey<number[]>('foldableHeading');

/** Each folded heading's position and the range it hides: up to the next heading of the same or a higher level. */
function foldedRanges(doc: ProseMirrorNode, folded: readonly number[]) {
  const ranges: { heading: number; from: number; to: number }[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading' || !folded.includes(offset)) return;
    const level = node.attrs.level as number;
    const from = offset + node.nodeSize;
    let to = from;
    let past = false;
    doc.forEach((next, nextOffset) => {
      if (past || nextOffset < from) return;
      if (next.type.name === 'heading' && (next.attrs.level as number) <= level) past = true;
      else to = nextOffset + next.nodeSize;
    });
    ranges.push({ heading: offset, from, to });
  });
  return ranges;
}

function chevron(pos: number, folded: boolean) {
  const button = document.createElement('span');
  button.className = folded ? 'fold-toggle folded' : 'fold-toggle';
  button.contentEditable = 'false';
  button.dataset.pos = String(pos);
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', folded ? 'Expand Section' : 'Collapse Section');
  button.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M4 2.5L7.5 6L4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return button;
}

function decorations(state: EditorState): DecorationSet {
  const folded = key.getState(state) ?? [];
  const out: Decoration[] = [];
  state.doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return;
    const isFolded = folded.includes(offset);
    out.push(Decoration.widget(offset + 1, () => chevron(offset, isFolded), { side: -1, ignoreSelection: true, key: `fold-${offset}-${isFolded}` }));
  });
  for (const range of foldedRanges(state.doc, folded)) {
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'folded-away' }));
      return false;
    });
  }
  return DecorationSet.create(state.doc, out);
}

/** Apple Notes' collapsible sections: the chevron beside a Title, Heading or Subheading hides what is under it. Folds
 * last for the session; the Markdown never stores them. Moving the caret into a hidden section opens it. */
export const FoldableHeading = Extension.create({
  name: 'foldableHeading',

  addProseMirrorPlugins() {
    return [
      new Plugin<number[]>({
        key,
        state: {
          init: () => [],
          apply: (tr, folded, _old, state) => {
            const toggle = tr.getMeta(key) as number | undefined;
            let next = folded.map((pos) => tr.mapping.map(pos)).filter((pos) => state.doc.nodeAt(pos)?.type.name === 'heading');
            if (toggle !== undefined) next = next.includes(toggle) ? next.filter((p) => p !== toggle) : [...next, toggle];
            if (next.length && tr.selectionSet) {
              const head = state.selection.head;
              const inside = foldedRanges(state.doc, next).find((r) => head > r.from && head < r.to);
              if (inside) next = next.filter((p) => p !== inside.heading);
            }
            return next;
          },
        },
        props: {
          decorations: decorations,
          handleDOMEvents: {
            mousedown: (view, event) => {
              const toggle = (event.target as HTMLElement | null)?.closest?.('.fold-toggle') as HTMLElement | null;
              if (!toggle) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.setMeta(key, Number(toggle.dataset.pos)));
              return true;
            },
          },
        },
      }),
    ];
  },
});
