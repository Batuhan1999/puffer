import type { AnyExtension } from '@tiptap/core';
import { Code } from '@tiptap/extension-code';
import { Highlight } from '@tiptap/extension-highlight';
import { BulletList, TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { StarterKit } from '@tiptap/starter-kit';

import { HIGHLIGHTS, NOTE_LINK } from '../markdown';
import { Attachment, type AttachmentOptions } from './attachment';

/** `* item` and `- item` are Apple Notes' bulleted and dashed lists; Markdown keeps them apart, so the node does too. */
const NoteBulletList = BulletList.extend({
  addAttributes() {
    return {
      dashed: {
        default: false,
        parseHTML: (el) => el.hasAttribute('data-dashed'),
        renderHTML: (attrs) => (attrs.dashed ? { 'data-dashed': '' } : {}),
      },
    };
  },
});

/** One of Apple Notes' five colors by name, as `==x==` (purple) or `<mark data-color="mint">` stores it. */
const NoteHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'purple',
        parseHTML: (el) => {
          const color = el.getAttribute('data-color');
          return color && (HIGHLIGHTS as readonly string[]).includes(color) ? color : 'purple';
        },
        renderHTML: (attrs) => ({ 'data-color': attrs.color }),
      },
    };
  },
}).configure({ multicolor: true });

/** Code may carry bold, italic and the rest, as `**`x`**` does in the Markdown. */
const NoteCode = Code.extend({ excludes: '' });

/** The nodes and marks a note can hold: what `markdown.ts` reads into and writes from. */
export function schemaExtensions(attachment?: AttachmentOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false,
      code: false,
      hardBreak: false,
      horizontalRule: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['puffer'],
        isAllowedUri: (url, ctx) => url.startsWith(NOTE_LINK) || ctx.defaultValidate(url),
      },
    }),
    NoteBulletList,
    NoteCode,
    NoteHighlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    attachment ? Attachment.configure(attachment) : Attachment,
  ];
}
