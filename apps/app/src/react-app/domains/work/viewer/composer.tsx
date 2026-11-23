/** @jsxImportSource react */
// The viewer's composer (judge M19): rich text with no visible Markdown. Bold, italic, links, bulleted and numbered
// lists, Cmd/Ctrl+B, I and K, a small toolbar, Cmd/Ctrl+Enter sends. The parent reads HTML, Markdown and plain text
// (composer-format.ts) and keeps a draft as the editor's own JSON.
import { AutoLinkNode, LinkNode, TOGGLE_LINK_COMMAND, $createLinkNode, $isLinkNode } from "@lexical/link";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode, REMOVE_LIST_COMMAND, $isListNode } from "@lexical/list";
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from "@lexical/react/LexicalAutoLinkPlugin.js";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer.js";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { ContentEditable } from "@lexical/react/LexicalContentEditable.js";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary.js";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin.js";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin.js";
import { ListPlugin } from "@lexical/react/LexicalListPlugin.js";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin.js";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin.js";
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection,
  CLEAR_EDITOR_COMMAND, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, KEY_DOWN_COMMAND, KEY_ENTER_COMMAND,
  SELECTION_CHANGE_COMMAND, type BaseSelection, type EditorState, type LexicalEditor,
} from "lexical";
import { Bold, Italic, Link2, List, ListOrdered, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { serializeRoot } from "./composer-format";
import { isMac, type ComposerContent } from "./records";

export const COMPOSER_NODES = [ListNode, ListItemNode, LinkNode, AutoLinkNode];

const THEME: InitialConfigType["theme"] = {
  paragraph: "m-0",
  text: { bold: "font-semibold", italic: "italic", underline: "underline", strikethrough: "line-through", code: "rounded bg-muted px-1 py-px font-mono text-[12px]" },
  link: "text-link underline underline-offset-2",
  list: {
    ul: "my-1 list-disc ps-5",
    ol: "my-1 list-decimal ps-5",
    listitem: "my-0.5",
    nested: { listitem: "list-none" },
  },
};

const URL_MATCHER = createLinkMatcherWithRegExp(/((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/, (text) => (text.startsWith("http") ? text : `https://${text}`));
const EMAIL_MATCHER = createLinkMatcherWithRegExp(/(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/, (text) => `mailto:${text}`);

export type RichComposerHandle = {
  content: () => ComposerContent;
  isEmpty: () => boolean;
  clear: () => void;
  focus: () => void;
  /** The editor's state as JSON, for a draft. */
  snapshot: () => string;
};

type Formats = { bold: boolean; italic: boolean; link: boolean; bullet: boolean; number: boolean };
const NO_FORMATS: Formats = { bold: false, italic: false, link: false, bullet: false, number: false };

function readFormats(): Formats {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return NO_FORMATS;
  const node = selection.anchor.getNode();
  let link = false;
  let list: string | null = null;
  for (let at: ReturnType<typeof node.getParent> | typeof node | null = node; at; at = at.getParent()) {
    if ($isLinkNode(at)) link = true;
    if ($isListNode(at)) { list = at.getListType(); break; }
  }
  return { bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic"), link, bullet: list === "bullet", number: list === "number" };
}

function ToolButton(props: { label: string; keys?: string; active?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.active}
            // Keep the editor's selection: the press acts on it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onPress}
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              props.active && "bg-muted text-foreground",
            )}
          >
            {props.children}
          </button>
        )}
      />
      <TooltipContent>{props.keys ? `${props.label} (${props.keys})` : props.label}</TooltipContent>
    </Tooltip>
  );
}

/** Toolbar, keyboard and the link field, inside the composer. */
function Controls(props: { onSubmit?: () => void; onEscape?: () => boolean; toolbar: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [formats, setFormats] = useState<Formats>(NO_FORMATS);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const saved = useRef<BaseSelection | null>(null);
  const submit = useRef(props.onSubmit);
  submit.current = props.onSubmit;
  const escape = useRef(props.onEscape);
  escape.current = props.onEscape;
  const mod = isMac() ? "⌘" : "Ctrl+";

  const openLink = useCallback(() => {
    editor.getEditorState().read(() => {
      const current = readFormats();
      if (current.link) {
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
        return;
      }
      saved.current = $getSelection()?.clone() ?? null;
      setUrl("");
      setLinkOpen(true);
    });
  }, [editor]);

  useEffect(() => {
    const offUpdate = editor.registerUpdateListener(({ editorState }) => editorState.read(() => setFormats(readFormats())));
    const offSelection = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => { setFormats(readFormats()); return false; }, COMMAND_PRIORITY_LOW);
    const offEnter = editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      if (!event || !(event.metaKey || event.ctrlKey)) return false;
      event.preventDefault();
      submit.current?.();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const offKey = editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
      const mac = isMac();
      const command = mac ? event.metaKey : event.ctrlKey;
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        // Cmd/Ctrl+K is a link here, not Work search.
        event.preventDefault();
        event.stopPropagation();
        openLink();
        return true;
      }
      if (event.key === "Escape" && escape.current?.()) {
        event.preventDefault();
        return true;
      }
      return false;
    }, COMMAND_PRIORITY_HIGH);
    return () => { offUpdate(); offSelection(); offEnter(); offKey(); };
  }, [editor, openLink]);

  const applyLink = () => {
    const value = url.trim();
    setLinkOpen(false);
    if (!value) { editor.focus(); return; }
    const href = /^(?:https?:\/\/|mailto:)/i.test(value) ? value : value.includes("@") && !value.includes("/") ? `mailto:${value}` : `https://${value}`;
    editor.update(() => {
      if (saved.current) $setSelection(saved.current.clone());
      const selection = $getSelection();
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const link = $createLinkNode(href);
        link.append($createTextNode(value));
        selection.insertNodes([link]);
      } else {
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
      }
    });
    editor.focus();
  };

  if (!props.toolbar && !linkOpen) return null;
  return linkOpen ? (
    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5" data-testid="work-composer-link">
      <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        autoFocus
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); applyLink(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setLinkOpen(false); editor.focus(); }
        }}
        placeholder={t("work.viewer.link_placeholder")}
        aria-label={t("work.viewer.link")}
        className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button type="button" onClick={applyLink} className="h-6 rounded-md px-2 text-[12px] font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">{t("work.viewer.link_apply")}</button>
      <button type="button" aria-label={t("common.cancel")} onClick={() => { setLinkOpen(false); editor.focus(); }} className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>
    </div>
  ) : (
    <div className="flex items-center gap-0.5 px-1.5 pt-1.5" role="toolbar" aria-label={t("work.viewer.formatting")} data-testid="work-composer-toolbar">
      <ToolButton label={t("work.viewer.bold")} keys={`${mod}B`} active={formats.bold} onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}><Bold className="size-3.5" /></ToolButton>
      <ToolButton label={t("work.viewer.italic")} keys={`${mod}I`} active={formats.italic} onPress={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}><Italic className="size-3.5" /></ToolButton>
      <ToolButton label={t("work.viewer.link")} keys={`${mod}K`} active={formats.link} onPress={openLink}><Link2 className="size-3.5" /></ToolButton>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolButton label={t("work.viewer.bulleted_list")} active={formats.bullet} onPress={() => editor.dispatchCommand(formats.bullet ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined)}><List className="size-3.5" /></ToolButton>
      <ToolButton label={t("work.viewer.numbered_list")} active={formats.number} onPress={() => editor.dispatchCommand(formats.number ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined)}><ListOrdered className="size-3.5" /></ToolButton>
    </div>
  );
}

/** Hands the parent the editor (read, clear, focus) and the empty state. */
function Bridge(props: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  const ready = useRef(props.onReady);
  useEffect(() => { ready.current(editor); }, [editor]);
  return null;
}

function ClearPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(CLEAR_EDITOR_COMMAND, () => {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      root.append($createParagraphNode());
      root.selectStart();
    });
    return true;
  }, COMMAND_PRIORITY_LOW), [editor]);
  return null;
}

/** Text a draft or a quick reply starts with, as paragraphs. */
function seed(text: string) {
  return () => {
    const root = $getRoot();
    root.clear();
    for (const line of text.split("\n")) root.append($createParagraphNode().append($createTextNode(line)));
  };
}

export const RichComposer = forwardRef(function RichComposer(props: {
  ariaLabel: string;
  placeholder: string;
  /** A draft: the editor's JSON (from `snapshot`) or plain text. */
  initial?: { editor?: string; text?: string };
  onChange?: (state: { editor: string; text: string }) => void;
  onSubmit?: () => void;
  /** Esc in the editor: true when the parent handled it (closing the composer). */
  onEscape?: () => boolean;
  toolbar?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Short one-line start (chat), growing as text comes. */
  compact?: boolean;
  footer?: ReactNode;
  className?: string;
  testId?: string;
}, ref: React.ForwardedRef<RichComposerHandle>) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const [empty, setEmpty] = useState(!props.initial?.text?.trim());
  const initialConfig: InitialConfigType = {
    namespace: "work-viewer-composer",
    theme: THEME,
    nodes: COMPOSER_NODES,
    editable: !props.disabled,
    onError: (error) => { throw error; },
    editorState: props.initial?.editor ? props.initial.editor : props.initial?.text ? seed(props.initial.text) : undefined,
  };
  const read = useCallback((): ComposerContent => {
    const editor = editorRef.current;
    if (!editor) return { html: "", markdown: "", text: "" };
    return editor.getEditorState().read(() => serializeRoot($getRoot()));
  }, []);
  useImperativeHandle(ref, () => ({
    content: read,
    isEmpty: () => !read().text.trim(),
    clear: () => { editorRef.current?.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined); setEmpty(true); },
    focus: () => editorRef.current?.focus(),
    snapshot: () => JSON.stringify(editorRef.current?.getEditorState().toJSON() ?? {}),
  }), [read]);
  const onChange = props.onChange;
  const change = useCallback((state: EditorState) => {
    const content = state.read(() => serializeRoot($getRoot()));
    setEmpty(!content.text.trim() && !state.read(() => $getRoot().getChildren().some((node) => $isListNode(node))));
    onChange?.({ editor: JSON.stringify(state.toJSON()), text: content.text });
  }, [onChange]);
  const toolbar = props.toolbar !== false;

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        className={cn(
          "flex flex-col rounded-xl border border-border bg-background transition-shadow focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/25",
          props.disabled && "opacity-60",
          props.className,
        )}
        data-testid={props.testId ?? "work-composer"}
      >
        <Controls onSubmit={props.onSubmit} onEscape={props.onEscape} toolbar={toolbar} />
        <div className="relative min-w-0">
          <RichTextPlugin
            contentEditable={(
              <ContentEditable
                aria-label={props.ariaLabel}
                aria-multiline
                className={cn(
                  "max-h-[38vh] overflow-y-auto px-3 text-[13px] leading-5 text-foreground outline-none [&_a]:cursor-text",
                  props.compact ? "min-h-9 py-2" : "min-h-[76px] py-2",
                )}
                data-work-composer-editor
              />
            )}
            placeholder={empty ? <div className={cn("pointer-events-none absolute left-3 select-none text-[13px] leading-5 text-muted-foreground", props.compact ? "top-2" : "top-2")}>{props.placeholder}</div> : null}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        {props.footer ? <div className="flex items-center gap-2 px-2 pb-2 pt-1">{props.footer}</div> : null}
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <AutoLinkPlugin matchers={[URL_MATCHER, EMAIL_MATCHER]} />
      <OnChangePlugin onChange={change} ignoreSelectionChange />
      <ClearPlugin />
      <Bridge onReady={(editor) => {
        editorRef.current = editor;
        if (props.autoFocus) editor.focus(undefined, { defaultSelection: "rootEnd" });
      }} />
    </LexicalComposer>
  );
});
