import { LitElement, css, html, nothing } from 'lit';
import { api, type Connection, type SchemaInfo, type SchemaObject } from '../api.js';
import { emit, store, StoreController } from '../store.js';

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string };

const quote = (name: string) => `[${name.replace(/]/g, ']]')}]`;

/**
 * Left-hand object explorer: connections → databases → tables/views → columns.
 * Everything below a connection is loaded lazily on expand.
 */
export class LmConnectionTree extends LitElement {
  static properties = {
    filter: { state: true },
  };

  declare filter: string;

  private databases = new Map<string, Load<string[]>>();
  private schemas = new Map<string, Load<SchemaInfo>>();
  /** Keys of folder/table nodes the user expanded (children are only rendered once expanded). */
  private expanded = new Set<string>();

  constructor() {
    super();
    new StoreController(this);
    this.filter = '';
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--wa-color-surface-lowered);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--wa-space-2xs);
      padding: var(--wa-space-xs) var(--wa-space-xs) var(--wa-space-xs) var(--wa-space-s);
      font-size: var(--wa-font-size-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--wa-color-text-quiet);
    }
    .head span {
      flex: 1;
    }
    .search {
      padding: 0 var(--wa-space-s) var(--wa-space-xs);
    }
    .scroll {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    wa-tree {
      --indent-guide-width: 1px;
      font-size: var(--wa-font-size-s);
    }
    wa-tree-item::part(label) {
      flex: 1;
      min-width: 0;
    }
    .node {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-width: 0;
      padding-right: var(--wa-space-xs);
      white-space: nowrap;
    }
    .node .text {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .node .meta {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      margin-left: auto;
      padding-left: 8px;
    }
    .node wa-icon {
      color: var(--wa-color-text-quiet);
      flex: none;
    }
    .node .actions {
      display: none;
      margin-left: auto;
    }
    wa-tree-item:hover > .node .actions,
    .node:hover .actions {
      display: flex;
    }
    .actions wa-button::part(base) {
      padding: 0 4px;
      height: 20px;
    }
    .error {
      color: var(--wa-color-danger-fill-loud);
      font-size: var(--wa-font-size-xs);
      white-space: normal;
    }
    .empty {
      padding: var(--wa-space-m);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      text-align: center;
    }
  `;

  render() {
    const connections = store.connections;
    return html`
      <div class="head">
        <span>Connections</span>
        <wa-button size="small" appearance="plain" title="New connection" @click=${() => emit(this, 'lm-edit-connection', { connectionId: null })}>
          <wa-icon name="plus" label="New connection"></wa-icon>
        </wa-button>
      </div>
      <div class="search">
        <wa-input size="small" placeholder="Filter objects…" with-clear .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)}>
          <wa-icon slot="start" name="magnifying-glass"></wa-icon>
        </wa-input>
      </div>
      <div class="scroll">
        ${connections.length === 0
          ? html`<div class="empty">
              No connections yet.<br /><br />
              <wa-button size="small" variant="brand" @click=${() => emit(this, 'lm-edit-connection', { connectionId: null })}>Add connection</wa-button>
            </div>`
          : html`<wa-tree selection="leaf">${connections.map((c) => this.renderConnection(c))}</wa-tree>`}
      </div>
    `;
  }

  private renderConnection(c: Connection) {
    const dbs = this.databases.get(c.id);
    return html`
      <wa-tree-item ?lazy=${!dbs} @wa-lazy-load=${(e: Event) => this.onLazy(e, () => this.loadDatabases(c.id))}>
        <div class="node" @dblclick=${(e: Event) => this.openQuery(e, c.id, c.database)}>
          <wa-icon name="server"></wa-icon>
          <span class="text" title="${c.host}">${c.name}</span>
          <span class="actions">
            <wa-button size="small" appearance="plain" title="New query" @click=${(e: Event) => this.openQuery(e, c.id, c.database)}>
              <wa-icon name="file-circle-plus" label="New query"></wa-icon>
            </wa-button>
            <wa-button size="small" appearance="plain" title="Refresh" @click=${(e: Event) => this.refresh(e, c.id)}>
              <wa-icon name="arrows-rotate" label="Refresh"></wa-icon>
            </wa-button>
            <wa-button size="small" appearance="plain" title="Edit" @click=${(e: Event) => this.stop(e, () => emit(this, 'lm-edit-connection', { connectionId: c.id }))}>
              <wa-icon name="pen" label="Edit"></wa-icon>
            </wa-button>
            <wa-button size="small" appearance="plain" title="Delete" @click=${(e: Event) => this.stop(e, () => this.deleteConnection(c))}>
              <wa-icon name="trash" label="Delete"></wa-icon>
            </wa-button>
          </span>
        </div>
        ${dbs?.state === 'error' ? html`<wa-tree-item><span class="error">${dbs.message}</span></wa-tree-item>` : nothing}
        ${dbs?.state === 'ok' ? dbs.value.map((db) => this.renderDatabase(c, db)) : nothing}
      </wa-tree-item>
    `;
  }

  private renderDatabase(c: Connection, db: string) {
    const key = `${c.id}|${db}`;
    const schema = this.schemas.get(key);
    return html`
      <wa-tree-item ?lazy=${!schema} @wa-lazy-load=${(e: Event) => this.onLazy(e, () => this.loadSchema(c.id, db))}>
        <div class="node" @dblclick=${(e: Event) => this.openQuery(e, c.id, db)}>
          <wa-icon name="database"></wa-icon>
          <span class="text">${db}</span>
          <span class="actions">
            <wa-button size="small" appearance="plain" title="New query" @click=${(e: Event) => this.openQuery(e, c.id, db)}>
              <wa-icon name="file-circle-plus" label="New query"></wa-icon>
            </wa-button>
          </span>
        </div>
        ${schema?.state === 'error' ? html`<wa-tree-item><span class="error">${schema.message}</span></wa-tree-item>` : nothing}
        ${schema?.state === 'ok' ? this.renderFolders(c, db, schema.value) : nothing}
      </wa-tree-item>
    `;
  }

  private renderFolders(c: Connection, db: string, info: SchemaInfo) {
    const f = this.filter.trim().toLowerCase();
    const all = info.schemas.flatMap((s) => s.objects.map((o) => ({ schema: s.name, o })));
    const matches = f ? all.filter(({ schema, o }) => `${schema}.${o.name}`.toLowerCase().includes(f)) : all;

    return (['table', 'view'] as const).map((type) => {
      const items = matches.filter((x) => x.o.type === type);
      const key = `${c.id}|${db}|${type}`;
      const open = this.expanded.has(key) || !!f;
      return html`
        <wa-tree-item ?lazy=${!open && items.length > 0} ?expanded=${!!f && items.length > 0} @wa-lazy-load=${(e: Event) => this.onLazy(e, async () => this.expanded.add(key))}>
          <div class="node">
            <wa-icon name=${type === 'table' ? 'table' : 'eye'}></wa-icon>
            <span class="text">${type === 'table' ? 'Tables' : 'Views'}</span>
            <span class="meta">${items.length}</span>
          </div>
          ${open ? items.map(({ schema, o }) => this.renderObject(c, db, schema, o)) : nothing}
        </wa-tree-item>
      `;
    });
  }

  private renderObject(c: Connection, db: string, schema: string, o: SchemaObject) {
    const key = `${c.id}|${db}|${schema}.${o.name}`;
    const open = this.expanded.has(key);
    const fq = `${quote(schema)}.${quote(o.name)}`;
    return html`
      <wa-tree-item ?lazy=${!open} @wa-lazy-load=${(e: Event) => this.onLazy(e, async () => this.expanded.add(key))}>
        <div class="node" @dblclick=${(e: Event) => this.selectTop(e, c.id, db, fq)}>
          <span class="text" title="${schema}.${o.name}">${schema}.${o.name}</span>
          <span class="actions">
            <wa-button size="small" appearance="plain" title="Select top 1000" @click=${(e: Event) => this.selectTop(e, c.id, db, fq)}>
              <wa-icon name="play" label="Select top 1000"></wa-icon>
            </wa-button>
          </span>
        </div>
        ${open
          ? o.columns.map(
              (col) => html`
                <wa-tree-item>
                  <div class="node">
                    <wa-icon name=${col.isPrimaryKey ? 'key' : 'minus'} style="font-size:0.8em"></wa-icon>
                    <span class="text">${col.name}</span>
                    <span class="meta">${col.dataType}${col.nullable ? '' : ' not null'}</span>
                  </div>
                </wa-tree-item>
              `,
            )
          : nothing}
      </wa-tree-item>
    `;
  }

  // ---- Data loading ------------------------------------------------------------

  /** Run a loader for a lazy node, then re-render so the node gets its children (which ends its loading state). */
  private async onLazy(e: Event, load: () => Promise<unknown>) {
    e.stopPropagation();
    await load();
    this.requestUpdate();
    await this.updateComplete;
    const item = e.target as HTMLElement & { lazy: boolean; loading: boolean; expanded: boolean };
    item.loading = false;
    item.lazy = false;
    item.expanded = true;
  }

  private async loadDatabases(connectionId: string) {
    try {
      this.databases.set(connectionId, { state: 'ok', value: await api.databases(connectionId) });
    } catch (e) {
      this.databases.set(connectionId, { state: 'error', message: (e as Error).message });
    }
  }

  private async loadSchema(connectionId: string, db: string) {
    try {
      this.schemas.set(`${connectionId}|${db}`, { state: 'ok', value: await store.schema(connectionId, db) });
    } catch (e) {
      this.schemas.set(`${connectionId}|${db}`, { state: 'error', message: (e as Error).message });
    }
  }

  private refresh(e: Event, connectionId: string) {
    e.stopPropagation();
    this.databases.delete(connectionId);
    for (const map of [this.schemas]) for (const k of [...map.keys()]) if (k.startsWith(connectionId)) map.delete(k);
    for (const k of [...this.expanded]) if (k.startsWith(connectionId)) this.expanded.delete(k);
    store.invalidateSchema(connectionId);
    this.requestUpdate();
  }

  // ---- Actions -------------------------------------------------------------------

  private stop(e: Event, fn: () => void) {
    e.stopPropagation();
    fn();
  }

  private openQuery(e: Event, connectionId: string, database: string | null) {
    e.stopPropagation();
    emit(this, 'lm-open-query', { connectionId, database });
  }

  private selectTop(e: Event, connectionId: string, database: string, fq: string) {
    e.stopPropagation();
    emit(this, 'lm-open-query', { connectionId, database, sql: `SELECT TOP (1000) *\nFROM ${fq};\n`, run: true });
  }

  private async deleteConnection(c: Connection) {
    if (!confirm(`Delete connection "${c.name}"?`)) return;
    await api.deleteConnection(c.id);
    this.databases.delete(c.id);
    await store.loadConnections();
  }
}

customElements.define('lm-connection-tree', LmConnectionTree);

declare global {
  interface HTMLElementTagNameMap {
    'lm-connection-tree': LmConnectionTree;
  }
}
