import { LitElement, css, html, type PropertyValues } from 'lit';
import { api, ApiError, type QueryResponse } from '../api.js';
import { store, StoreController } from '../store.js';
import type { LmSqlEditor, RunDetail } from './lm-sql-editor.js';
import './lm-sql-editor.js';
import './lm-results.js';

export interface QueryTabModel {
  id: string;
  connectionId: string | null;
  database: string | null;
  sql: string;
  /** Run once the editor is ready (used by "Select top 1000"). */
  runOnOpen?: boolean;
}

/** One query document: toolbar (connection + database + run), editor on top, results below. */
export class LmQueryTab extends LitElement {
  static properties = {
    model: { attribute: false },
    databases: { state: true },
    running: { state: true },
    response: { state: true },
    failure: { state: true },
  };

  declare model: QueryTabModel;
  declare databases: string[];
  declare running: boolean;
  declare response: QueryResponse | null;
  declare failure: string | null;

  private abort?: AbortController;
  private schemaRequest = 0;

  constructor() {
    super();
    new StoreController(this);
    this.databases = [];
    this.running = false;
    this.response = null;
    this.failure = null;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
      padding: var(--wa-space-2xs) var(--wa-space-s);
      border-bottom: 1px solid var(--wa-color-surface-border);
      flex: none;
    }
    .toolbar wa-select {
      width: 220px;
    }
    .toolbar .hint {
      margin-left: auto;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
    wa-split-panel {
      flex: 1;
      min-height: 0;
      --min: 80px;
      --max: calc(100% - 80px);
    }
    wa-split-panel::part(divider) {
      background: var(--wa-color-surface-border);
    }
    [slot] {
      min-height: 0;
      overflow: hidden;
    }
  `;

  private get editor() {
    return this.renderRoot.querySelector<LmSqlEditor>('lm-sql-editor')!;
  }

  render() {
    const m = this.model;
    const dbIndex = m.database ? this.databases.indexOf(m.database) : -1;
    return html`
      <div class="toolbar">
        <wa-button size="small" variant="brand" ?loading=${this.running} ?disabled=${!m.connectionId} @click=${() => this.run(this.editor.getRunTarget())}>
          <wa-icon slot="start" name="play"></wa-icon>Run
        </wa-button>
        <wa-button size="small" appearance="outlined" ?disabled=${!this.running} @click=${this.cancel}>
          <wa-icon slot="start" name="stop"></wa-icon>Cancel
        </wa-button>
        <wa-select
          size="small"
          placeholder="Connection"
          value=${m.connectionId ?? ''}
          @change=${(e: Event) => this.setConnection((e.target as HTMLSelectElement).value || null)}
        >
          ${store.connections.map((c) => html`<wa-option value=${c.id}>${c.name}</wa-option>`)}
        </wa-select>
        <wa-select
          size="small"
          placeholder="Database"
          value=${dbIndex >= 0 ? String(dbIndex) : ''}
          ?disabled=${!m.connectionId}
          @change=${(e: Event) => this.setDatabase(this.databases[Number((e.target as HTMLSelectElement).value)] ?? null)}
        >
          ${this.databases.map((d, i) => html`<wa-option value=${String(i)}>${d}</wa-option>`)}
        </wa-select>
        <span class="hint">Ctrl+Enter / F5 to run · Ctrl+Space for suggestions</span>
      </div>
      <wa-split-panel orientation="vertical" position="45">
        <lm-sql-editor slot="start" .value=${m.sql} @lm-run=${(e: CustomEvent<RunDetail>) => this.run(e.detail)}></lm-sql-editor>
        <lm-results slot="end" .response=${this.response} .running=${this.running} .failure=${this.failure}></lm-results>
      </wa-split-panel>
    `;
  }

  firstUpdated() {
    this.loadDatabases();
    this.loadSchema();
    if (this.model.runOnOpen) {
      this.model.runOnOpen = false;
      requestAnimationFrame(() => this.run(this.editor.getRunTarget()));
    }
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has('model') && changed.get('model')) {
      this.loadDatabases();
      this.loadSchema();
    }
  }

  focusEditor() {
    this.editor?.focus();
  }

  private changed() {
    this.model.sql = this.editor.value;
    this.dispatchEvent(new CustomEvent('lm-tab-change', { bubbles: true, composed: true }));
    this.requestUpdate();
  }

  private setConnection(id: string | null) {
    if (id === this.model.connectionId) return;
    this.model.connectionId = id;
    this.model.database = store.connection(id)?.database ?? null;
    this.databases = [];
    this.changed();
    this.loadDatabases();
    this.loadSchema();
  }

  private setDatabase(db: string | null) {
    if (db === this.model.database) return;
    this.model.database = db;
    this.changed();
    this.loadSchema();
  }

  private async loadDatabases() {
    const id = this.model.connectionId;
    if (!id) return;
    try {
      const dbs = await api.databases(id);
      if (id !== this.model.connectionId) return;
      this.databases = dbs;
      if (!this.model.database) {
        this.model.database = store.connection(id)?.database ?? null;
        this.changed();
      }
    } catch {
      this.databases = [];
    }
  }

  private async loadSchema() {
    const { connectionId, database } = this.model;
    const req = ++this.schemaRequest;
    await this.updateComplete;
    if (!connectionId) {
      this.editor.setSchema('sqlserver', null);
      return;
    }
    const provider = store.connection(connectionId)?.provider ?? 'sqlserver';
    try {
      const schema = await store.schema(connectionId, database);
      if (req === this.schemaRequest) this.editor.setSchema(provider, schema);
    } catch {
      if (req === this.schemaRequest) this.editor.setSchema(provider, null);
    }
  }

  private async run(target: RunDetail) {
    const { connectionId, database } = this.model;
    if (!connectionId || this.running || !target.sql.trim()) return;
    this.model.sql = this.editor.value;

    this.abort = new AbortController();
    this.running = true;
    this.failure = null;
    this.response = null;
    try {
      const res = await api.query(connectionId, database, target.sql, this.abort.signal);
      this.response = res;
      if (res.error?.line) this.editor.markError(target.startLine + res.error.line - 1);
    } catch (e) {
      if ((e as Error).name === 'AbortError') this.failure = 'Query cancelled.';
      else this.failure = e instanceof ApiError ? e.message : String(e);
    } finally {
      this.running = false;
      this.abort = undefined;
    }
  }

  private cancel = () => this.abort?.abort();
}

customElements.define('lm-query-tab', LmQueryTab);

declare global {
  interface HTMLElementTagNameMap {
    'lm-query-tab': LmQueryTab;
  }
}
