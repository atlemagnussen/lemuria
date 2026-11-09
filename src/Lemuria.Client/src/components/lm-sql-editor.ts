import { LitElement, css, html } from 'lit';
import { basicSetup } from 'codemirror';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MSSQL, PostgreSQL, sql, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql';
import type { Completion, CompletionSource } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import type { SchemaInfo } from '../api.js';
import { currentTheme } from '../store.js';
import { completeColumns, type ColumnOptions } from '../sql-columns.js';

const dialects: Record<string, { dialect: SQLDialect; defaultSchema: string; quoting: ColumnOptions['quoting'] }> = {
  sqlserver: { dialect: MSSQL, defaultSchema: 'dbo', quoting: 'brackets' },
  postgres: { dialect: PostgreSQL, defaultSchema: 'public', quoting: 'double' },
};

/**
 * Unqualified column names from the tables in the current statement (lang-sql only completes
 * `alias.column`). Runs alongside lang-sql's source; see sql-columns.ts for the rules.
 */
function columnSource(info: SchemaInfo, d: (typeof dialects)[string]): CompletionSource {
  return (ctx) => {
    const r = completeColumns(ctx.state.doc.toString(), ctx.pos, info, {
      defaultSchema: d.defaultSchema,
      quoting: d.quoting,
      explicit: ctx.explicit,
    });
    if (!r || r.options.length === 0) return null;
    return {
      from: r.from,
      options: r.options.map(
        (o): Completion => ({
          label: o.label,
          displayLabel: o.insert,
          apply: o.insert,
          detail: o.detail,
          type: 'property',
          boost: 20, // rank columns above keywords and table names where a column fits
        }),
      ),
      validFor: /^[\p{L}\p{N}_$#@]*$/u,
    };
  };
}

const errorLineDeco = Decoration.line({ class: 'cm-errorLine' });
const setErrorLine = StateEffect.define<number | null>();
/** Highlights the line of the last query error; cleared on the next edit. */
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects)
      if (e.is(setErrorLine)) return e.value === null ? Decoration.none : Decoration.set([errorLineDeco.range(e.value)]);
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Syntax colors come from CSS variables (see styles/app.css), so one style serves both themes. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--lm-syntax-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--lm-syntax-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--lm-syntax-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--lm-syntax-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--lm-syntax-operator)' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--lm-syntax-type)' },
  { tag: t.special(t.name), color: 'var(--lm-syntax-type)' },
]);

const baseTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        color: 'var(--wa-color-text-normal)',
        backgroundColor: 'var(--wa-color-surface-default)',
      },
      '.cm-scroller': { fontFamily: 'var(--wa-font-family-code)', lineHeight: '1.55' },
      '.cm-content': { caretColor: 'var(--wa-color-brand-fill-loud)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--wa-color-brand-fill-loud)' },
      '.cm-gutters': {
        backgroundColor: 'var(--wa-color-surface-default)',
        color: 'var(--wa-color-text-quiet)',
        border: 'none',
      },
      '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--wa-color-text-normal) 4%, transparent)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--wa-color-text-normal)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
        { backgroundColor: 'var(--lm-selection) !important' },
      '.cm-tooltip': {
        backgroundColor: 'var(--wa-color-surface-raised)',
        color: 'var(--wa-color-text-normal)',
        border: '1px solid var(--wa-color-surface-border)',
        borderRadius: 'var(--wa-border-radius-m)',
        boxShadow: 'var(--wa-shadow-m)',
      },
      '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--wa-font-family-code)', maxHeight: '18em' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--wa-color-brand-fill-loud)',
        color: 'var(--wa-color-brand-on-loud)',
      },
      '.cm-completionDetail': { opacity: '0.7', marginLeft: '1em', fontStyle: 'normal' },
      '.cm-errorLine': { backgroundColor: 'color-mix(in oklab, var(--wa-color-danger-fill-loud) 18%, transparent)' },
    },
    { dark },
  );

/** Convert server schema metadata into lang-sql's completion namespace. */
function toNamespace(info: SchemaInfo): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  for (const s of info.schemas) {
    const children: Record<string, SQLNamespace> = {};
    for (const o of s.objects) {
      children[o.name] = {
        self: { label: o.name, type: o.type === 'view' ? 'interface' : 'class', detail: o.type } satisfies Completion,
        children: o.columns.map(
          (c): Completion => ({
            label: c.name,
            type: 'property',
            detail: `${c.dataType}${c.isPrimaryKey ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}`,
          }),
        ),
      };
    }
    ns[s.name] = { self: { label: s.name, type: 'namespace' }, children };
  }
  return ns;
}

export interface RunDetail {
  sql: string;
  /** 1-based line where the executed text starts (for mapping error lines when running a selection). */
  startLine: number;
}

/**
 * SQL editor built on CodeMirror 6 (lightweight, shadow-DOM friendly, first-class SQL autocomplete).
 * Emits `lm-run` on Ctrl/Cmd+Enter or F5 with the selection (or whole document).
 */
export class LmSqlEditor extends LitElement {
  static properties = {
    value: {},
  };

  declare value: string;

  private view?: EditorView;
  private language = new Compartment();
  private theme = new Compartment();
  private onTheme = () => this.view?.dispatch({ effects: this.theme.reconfigure(baseTheme(currentTheme() === 'dark')) });

  constructor() {
    super();
    this.value = '';
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
    }
    .host {
      height: 100%;
    }
  `;

  render() {
    return html`<div class="host"></div>`;
  }

  firstUpdated() {
    const run = () => {
      this.dispatchEvent(new CustomEvent<RunDetail>('lm-run', { detail: this.getRunTarget(), bubbles: true, composed: true }));
      return true;
    };

    this.view = new EditorView({
      parent: this.renderRoot.querySelector('.host')!,
      root: this.renderRoot as ShadowRoot,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run },
              { key: 'F5', run, preventDefault: true },
            ]),
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          this.language.of(sql({ dialect: MSSQL, upperCaseKeywords: true })),
          this.theme.of(baseTheme(currentTheme() === 'dark')),
          errorLineField,
          syntaxHighlighting(highlight),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.value = u.state.doc.toString();
          }),
        ],
      }),
    });
    window.addEventListener('lm-theme-change', this.onTheme);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('lm-theme-change', this.onTheme);
  }

  /** Enable schema-aware completion (tables, views, columns, aliases) for the given provider. */
  setSchema(provider: string, info: SchemaInfo | null) {
    const d = dialects[provider] ?? dialects.sqlserver;
    const lang = sql({
      dialect: d.dialect,
      upperCaseKeywords: true,
      schema: info ? toNamespace(info) : undefined,
      defaultSchema: d.defaultSchema,
    });
    this.view?.dispatch({
      effects: this.language.reconfigure(
        info ? [lang, lang.language.data.of({ autocomplete: columnSource(info, d) })] : lang,
      ),
    });
  }

  getRunTarget(): RunDetail {
    const state = this.view!.state;
    const sel = state.selection.main;
    if (!sel.empty) return { sql: state.sliceDoc(sel.from, sel.to), startLine: state.doc.lineAt(sel.from).number };
    return { sql: state.doc.toString(), startLine: 1 };
  }

  /** Highlight and jump to a (1-based) line, e.g. where a query error occurred. */
  markError(line: number) {
    const view = this.view;
    if (!view || line < 1 || line > view.state.doc.lines) return;
    const l = view.state.doc.line(line);
    view.dispatch({
      selection: EditorSelection.cursor(l.from),
      scrollIntoView: true,
      effects: setErrorLine.of(l.from),
    });
    view.focus();
  }

  insertText(text: string) {
    const view = this.view;
    if (!view) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }

  focus() {
    this.view?.focus();
  }
}

customElements.define('lm-sql-editor', LmSqlEditor);

declare global {
  interface HTMLElementTagNameMap {
    'lm-sql-editor': LmSqlEditor;
  }
  interface HTMLElementEventMap {
    'lm-run': CustomEvent<RunDetail>;
  }
}
