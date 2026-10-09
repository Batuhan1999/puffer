import type { Editor, JSONContent } from '@tiptap/core';

import { docToMarkdown, fromDoc, moveCheckedToBottom, toDoc, uncheckAll, type Paragraph } from './markdown';
import type { BlockStyle, EditorCommand, FormatState, ListStyle, MarkName } from './types';

const LEVEL = { title: 1, heading: 2, subheading: 3 } as const;
const MARKS: readonly MarkName[] = ['bold', 'italic', 'underline', 'strike'];

/** Focuses the editor, at the end when asked. Not Tiptap's `focus` command: on iOS it focuses the DOM before its own
 * transaction applies, ProseMirror dispatches a selection change on that focus, and the command's transaction then fails
 * ("Applying a mismatched transaction"). ProseMirror's view.focus writes the selection to the DOM instead of reading it. */
export function focusEditor(editor: Editor, at?: 'end') {
  if (at === 'end') editor.commands.setTextSelection(editor.state.doc.content.size);
  editor.view.focus();
}

/** Puts the caret on a new empty line at the end of the note, for toolbar actions taken while not editing. */
function atEnd(editor: Editor) {
  const last = editor.state.doc.lastChild;
  if (last && !(last.type.name === 'paragraph' && last.content.size === 0)) {
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' });
  }
  focusEditor(editor, 'end');
}

function transform(editor: Editor, change: (paragraphs: Paragraph[]) => Paragraph[]) {
  const json: JSONContent = toDoc(change(fromDoc(editor.getJSON())));
  editor.commands.setContent(json, { emitUpdate: true });
}

function setList(editor: Editor, list: ListStyle) {
  const current = formatState(editor).list;
  const chain = editor.chain();
  if (list === 'checklist') return chain.toggleTaskList().run();
  if (list === 'number') return chain.toggleOrderedList().run();
  if (current === list) return chain.toggleBulletList().run();
  if (current !== 'bullet' && current !== 'dash') chain.toggleBulletList();
  return chain.updateAttributes('bulletList', { dashed: list === 'dash' }).run();
}

function setBlock(editor: Editor, style: BlockStyle) {
  if (style === 'mono') return editor.chain().toggleCodeBlock().run();
  const chain = editor.chain().clearNodes();
  return style === 'body' ? chain.run() : chain.setHeading({ level: LEVEL[style] }).run();
}

/** One table of what each host command does to the editor. Commands from the Aa panel leave focus alone, so the panel
 * stays up; those from the bottom toolbar start editing. */
export function runCommand(editor: Editor, command: EditorCommand) {
  switch (command.kind) {
    case 'block': return setBlock(editor, command.style);
    case 'mark': return editor.chain().toggleMark(command.mark).run();
    case 'highlight':
      return command.color ? editor.chain().setHighlight({ color: command.color }).run() : editor.chain().unsetHighlight().run();
    case 'list': return setList(editor, command.list);
    case 'quote': return editor.chain().toggleBlockquote().run();
    case 'indent': {
      const types = ['listItem', 'taskItem'];
      return types.some((t) => (command.delta > 0 ? editor.commands.sinkListItem(t) : editor.commands.liftListItem(t)));
    }
    case 'checklist':
      if (!editor.isFocused) atEnd(editor);
      return editor.chain().toggleTaskList().run();
    case 'insertTable':
      if (!editor.isFocused) atEnd(editor);
      return editor.chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    case 'table': return editor.chain()[command.action]().run();
    case 'moveCheckedToBottom': return transform(editor, moveCheckedToBottom);
    case 'uncheckAll': return transform(editor, uncheckAll);
    case 'insertAttachments': {
      if (!editor.isFocused) atEnd(editor);
      const blocks = command.refs.map((ref) => ({ type: 'paragraph', content: [{ type: 'attachment', attrs: ref }] }));
      return editor.chain().insertContent(blocks).run();
    }
    case 'find': return (window as unknown as { find: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find(command.text, false, false, true);
    case 'focus': return focusEditor(editor);
    case 'blur': return editor.commands.blur();
  }
}

/** The innermost list around the selection decides the list style, as nested lists can mix them. */
export function formatState(editor: Editor): FormatState {
  const { $from } = editor.state.selection;
  let list: ListStyle | null = null;
  for (let depth = $from.depth; depth > 0 && !list; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'taskList') list = 'checklist';
    else if (node.type.name === 'orderedList') list = 'number';
    else if (node.type.name === 'bulletList') list = node.attrs.dashed ? 'dash' : 'bullet';
  }
  const block: BlockStyle =
    editor.isActive('heading', { level: 1 }) ? 'title'
    : editor.isActive('heading', { level: 2 }) ? 'heading'
    : editor.isActive('heading', { level: 3 }) ? 'subheading'
    : editor.isActive('codeBlock') ? 'mono'
    : 'body';
  return {
    block,
    list,
    quoted: editor.isActive('blockquote'),
    marks: MARKS.filter((m) => editor.isActive(m)),
    highlight: editor.isActive('highlight') ? (editor.getAttributes('highlight').color ?? 'purple') : null,
    inTable: editor.isActive('table'),
  };
}

export const markdownOf = (editor: Editor) => docToMarkdown(editor.getJSON());
