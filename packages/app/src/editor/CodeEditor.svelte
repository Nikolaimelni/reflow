<script lang="ts">
  import { css as cssLanguage } from '@codemirror/lang-css';
  import { html as htmlLanguage } from '@codemirror/lang-html';
  import { EditorState } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { basicSetup } from 'codemirror';
  import { untrack } from 'svelte';

  type Props = {
    value: string;
    language: 'html' | 'css';
    onchange: (value: string) => void;
  };

  const { value, language, onchange }: Props = $props();

  // Read once on purpose: the editor owns its text after mount, and re-creating it on every
  // keystroke would throw the cursor away.
  const initial = untrack(() => value);

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  $effect(() => {
    if (host === undefined) return;

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          language === 'html' ? htmlLanguage() : cssLanguage(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onchange(update.state.doc.toString());
          }),
        ],
      }),
    });

    return () => {
      view?.destroy();
      view = undefined;
    };
  });

  // A permalink is decoded after the first paint, so the text can change under an editor that
  // is already up. Anything the editor typed itself is already equal and does not come back.
  $effect(() => {
    const next = value;
    const current = view;
    if (current === undefined || current.state.doc.toString() === next) return;

    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: next } });
  });
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    min-height: 0;
    overflow: auto;
    background: var(--surface);
  }

  .editor :global(.cm-editor) {
    height: 100%;
    font-size: 13px;
  }

  .editor :global(.cm-editor.cm-focused) {
    outline: none;
  }

  .editor :global(.cm-gutters) {
    background: var(--surface-2);
    border-right: 1px solid var(--rule);
    color: var(--ink-3);
  }
</style>
