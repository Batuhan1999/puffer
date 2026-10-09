import { Extension, InputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { focusEditor } from '../commands';
import { NOTE_LINK } from '../markdown';

export type NoteLinkOptions = {
  openNote: (id: string) => void;
  openURL: (url: string) => void;
  /** The `>>` sheet; null when dismissed. */
  pickNote: () => Promise<{ id: string; title: string } | null>;
};

/** Links to other notes (`[Title](puffer://note/<id>)`) and the web: a tap opens them, `>>` inserts a note link. */
export const NoteLink = Extension.create<NoteLinkOptions>({
  name: 'noteLink',

  addOptions() {
    return { openNote: () => {}, openURL: () => {}, pickNote: async () => null };
  },

  addInputRules() {
    return [
      new InputRule({
        find: />>$/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to);
          void this.options.pickNote().then((picked) => {
            const editor = this.editor;
            if (editor.isDestroyed) return;
            if (picked) {
              editor.commands.insertContent([
                { type: 'text', text: picked.title, marks: [{ type: 'link', attrs: { href: NOTE_LINK + picked.id } }] },
                { type: 'text', text: ' ' },
              ]);
            }
            focusEditor(editor);
          });
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const { openNote, openURL } = this.options;
    return [
      new Plugin({
        key: new PluginKey('noteLinkClick'),
        props: {
          handleClick: (view, pos, event) => {
            const link = (event.target as HTMLElement | null)?.closest?.('a[href]');
            if (!link) return false;
            const href = link.getAttribute('href') ?? '';
            if (href.startsWith(NOTE_LINK)) openNote(href.slice(NOTE_LINK.length));
            else if (/^https?:/i.test(href)) openURL(href);
            else return false;
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
