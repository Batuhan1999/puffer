import { Node } from '@tiptap/core';

import type { AttachmentPreview, AttachmentRef } from '../types';

export type AttachmentOptions = {
  preview: (ref: AttachmentRef) => Promise<AttachmentPreview>;
  open: (ref: AttachmentRef) => void;
};

const SYMBOLS: Record<'pdf' | 'file' | 'missing', string> = {
  pdf: '<path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  file: '<path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  missing: '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10v5M12 17.5v.5" stroke="currentColor" stroke-width="1.6"/>',
};

function render(element: HTMLElement, preview: AttachmentPreview) {
  element.replaceChildren();
  if (preview.kind === 'image') {
    const image = document.createElement('img');
    image.src = preview.src;
    image.draggable = false;
    element.className = 'attachment attachment-image';
    element.append(image);
    return;
  }
  element.className = 'attachment attachment-card';
  const icon = document.createElement('span');
  icon.className = 'attachment-icon';
  if (preview.thumbnail) {
    const thumb = document.createElement('img');
    thumb.src = preview.thumbnail;
    icon.append(thumb);
  } else {
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28">${SYMBOLS[preview.symbol]}</svg>`;
  }
  const text = document.createElement('span');
  text.className = 'attachment-text';
  const title = document.createElement('span');
  title.className = 'attachment-title';
  title.textContent = preview.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'attachment-subtitle';
  subtitle.textContent = preview.subtitle;
  text.append(title, subtitle);
  element.append(icon, text);
}

type AttachmentStorage = { previews: Map<string, Promise<AttachmentPreview>>; views: Set<() => void> };

declare module '@tiptap/core' {
  interface Storage {
    attachment: AttachmentStorage;
  }
}

/** `![name](attachment:<file>)`: a photo, scan, PDF or drawing in Documents/NoteAttachments/<note id>/. Inline, as in
 * the Markdown, and shown as a block. Previews are cached per file until `refreshAttachments`. */
export const Attachment = Node.create<AttachmentOptions, AttachmentStorage>({
  name: 'attachment',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      preview: async (ref) => ({ kind: 'card', title: ref.name, subtitle: '', thumbnail: null, symbol: 'file' }),
      open: () => {},
    };
  },

  addStorage() {
    return { previews: new Map(), views: new Set() };
  },

  addAttributes() {
    return {
      name: { default: '' },
      file: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-attachment]', getAttrs: (el) => ({ name: el.getAttribute('data-name') ?? '', file: el.getAttribute('data-attachment') ?? '' }) }];
  },

  renderHTML({ node }) {
    return ['span', { 'data-attachment': node.attrs.file, 'data-name': node.attrs.name }, `[${node.attrs.name}]`];
  },

  renderText({ node }) {
    return `[${node.attrs.name}]`;
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.contentEditable = 'false';
      dom.className = 'attachment attachment-card';
      let ref: AttachmentRef = { name: node.attrs.name, file: node.attrs.file };
      const show = () => {
        const previews = this.storage.previews;
        let preview = previews.get(ref.file);
        if (!preview) {
          preview = this.options.preview(ref);
          previews.set(ref.file, preview);
        }
        const shown = ref.file;
        void preview.then((p) => { if (shown === ref.file) render(dom, p); }, () => previews.delete(shown));
      };
      dom.addEventListener('click', (event) => {
        event.preventDefault();
        this.options.open(ref);
      });
      show();
      this.storage.views.add(show);
      return {
        dom,
        destroy: () => this.storage.views.delete(show),
        update: (updated) => {
          if (updated.type.name !== 'attachment') return false;
          if (updated.attrs.file !== ref.file || updated.attrs.name !== ref.name) {
            ref = { name: updated.attrs.name, file: updated.attrs.file };
            show();
          }
          return true;
        },
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        ignoreMutation: () => true,
        stopEvent: (event) => event.type === 'click',
      };
    };
  },
});

/** Forgets cached previews and fetches them again, so a drawing that changed shows its new picture. */
export function refreshAttachments(storage: AttachmentStorage) {
  storage.previews.clear();
  for (const show of storage.views) show();
}
