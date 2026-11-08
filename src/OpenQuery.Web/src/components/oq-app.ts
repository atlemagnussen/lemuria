import { LitElement, css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { currentTheme, setTheme, store, StoreController, type EditConnectionDetail, type OpenQueryDetail } from '../store.js';
import type { OqConnectionDialog } from './oq-connection-dialog.js';
import type { OqQueryTab, QueryTabModel } from './oq-query-tab.js';
import './oq-connection-tree.js';
import './oq-connection-dialog.js';
import './oq-query-tab.js';

const TABS_KEY = 'oq-tabs';

/** App shell: header, left object explorer, right tabbed query area. */
export class OqApp extends LitElement {
  static properties = {
    tabs: { state: true },
    activeId: { state: true },
    loadError: { state: true },
  };

  declare tabs: QueryTabModel[];
  declare activeId: string | null;
  declare loadError: string | null;

  private saveTimer = 0;

  constructor() {
    super();
    new StoreController(this);
    const saved = restoreTabs();
    this.tabs = saved.tabs;
    this.activeId = saved.tabs.some((t) => t.id === saved.activeId) ? saved.activeId : (saved.tabs[0]?.id ?? null);
    this.loadError = null;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    header {
      display: flex;
      align-items: center;
      gap: var(--wa-space-s);
      height: var(--oq-header-height);
      padding: 0 var(--wa-space-s) 0 var(--wa-space-m);
      border-bottom: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-raised);
      flex: none;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .brand wa-icon {
      color: var(--wa-color-brand-fill-loud);
    }
    header .spacer {
      flex: 1;
    }
    wa-split-panel.main {
      flex: 1;
      min-height: 0;
      --min: 180px;
      --max: 50%;
    }
    wa-split-panel.main::part(divider) {
      background: var(--wa-color-surface-border);
    }
    .workspace {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
    }
    .tabstrip {
      display: flex;
      align-items: stretch;
      height: 34px;
      border-bottom: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-lowered);
      overflow-x: auto;
      flex: none;
    }
    .qtab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 6px 0 12px;
      max-width: 240px;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
      border-right: 1px solid var(--wa-color-surface-border);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .qtab .label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qtab.active {
      color: var(--wa-color-text-normal);
      background: var(--wa-color-surface-default);
      box-shadow: inset 0 2px 0 var(--wa-color-brand-fill-loud);
    }
    .qtab .close {
      all: unset;
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border-radius: var(--wa-border-radius-s);
      opacity: 0.6;
    }
    .qtab .close:hover {
      opacity: 1;
      background: var(--wa-color-neutral-fill-quiet);
    }
    .add {
      all: unset;
      padding: 0 12px;
      cursor: pointer;
      color: var(--wa-color-text-quiet);
    }
    .add:hover {
      color: var(--wa-color-text-normal);
    }
    .tabs {
      position: relative;
      flex: 1;
      min-height: 0;
    }
    oq-query-tab {
      position: absolute;
      inset: 0;
    }
    oq-query-tab:not([active]) {
      display: none;
    }
    .welcome {
      display: grid;
      place-content: center;
      gap: var(--wa-space-m);
      height: 100%;
      text-align: center;
      color: var(--wa-color-text-quiet);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    store.loadConnections().catch((e) => (this.loadError = String(e?.message ?? e)));
    this.addEventListener('oq-open-query', this.onOpenQuery);
    this.addEventListener('oq-edit-connection', this.onEditConnection);
    this.addEventListener('oq-tab-change', this.persist);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('beforeunload', this.persistNow);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('beforeunload', this.persistNow);
  }

  render() {
    const dark = currentTheme() === 'dark';
    return html`
      <header>
        <div class="brand"><wa-icon name="database"></wa-icon> Open Query</div>
        <span class="spacer"></span>
        <wa-button
          size="small"
          appearance="plain"
          title=${dark ? 'Switch to light theme' : 'Switch to dark theme'}
          @click=${() => {
            setTheme(dark ? 'light' : 'dark');
            this.requestUpdate();
          }}
        >
          <wa-icon name=${dark ? 'sun' : 'moon'} label="Toggle theme"></wa-icon>
        </wa-button>
      </header>
      ${this.loadError ? html`<wa-callout variant="danger">Could not reach the server: ${this.loadError}</wa-callout>` : nothing}
      <wa-split-panel class="main" position-in-pixels="280" primary="start">
        <oq-connection-tree slot="start"></oq-connection-tree>
        <div class="workspace" slot="end">
          <div class="tabstrip">
            ${repeat(
              this.tabs,
              (t) => t.id,
              (t) => html`
                <div class="qtab ${t.id === this.activeId ? 'active' : ''}" @click=${() => this.activate(t.id)} @auxclick=${(e: MouseEvent) => e.button === 1 && this.close(t.id)}>
                  <span class="label">${this.tabTitle(t)}</span>
                  <button class="close" title="Close" @click=${(e: Event) => (e.stopPropagation(), this.close(t.id))}>✕</button>
                </div>
              `,
            )}
            <button class="add" title="New query (Ctrl+Alt+N)" @click=${() => this.newTab()}>＋</button>
          </div>
          <div class="tabs">
            ${repeat(
              this.tabs,
              (t) => t.id,
              (t) => html`<oq-query-tab .model=${t} ?active=${t.id === this.activeId}></oq-query-tab>`,
            )}
            ${this.tabs.length === 0 ? this.renderWelcome() : nothing}
          </div>
        </div>
      </wa-split-panel>
      <oq-connection-dialog></oq-connection-dialog>
    `;
  }

  private renderWelcome() {
    const hasConnections = store.connections.length > 0;
    return html`
      <div class="welcome">
        <div>${hasConnections ? 'Open a new query to get started.' : 'Add a SQL Server connection to get started.'}</div>
        <div>
          ${hasConnections
            ? html`<wa-button variant="brand" @click=${() => this.newTab()}>New query</wa-button>`
            : html`<wa-button variant="brand" @click=${() => this.dialog.edit(null)}>Add connection</wa-button>`}
        </div>
      </div>
    `;
  }

  private get dialog() {
    return this.renderRoot.querySelector<OqConnectionDialog>('oq-connection-dialog')!;
  }

  private tabTitle(t: QueryTabModel) {
    const conn = store.connection(t.connectionId);
    if (!conn) return 'Query';
    return t.database ? `${t.database} · ${conn.name}` : conn.name;
  }

  private newTab(detail?: Partial<OpenQueryDetail>) {
    const active = this.tabs.find((t) => t.id === this.activeId);
    const connectionId = detail?.connectionId ?? active?.connectionId ?? store.connections[0]?.id ?? null;
    const tab: QueryTabModel = {
      id: crypto.randomUUID(),
      connectionId,
      database: detail?.database ?? (detail?.connectionId ? null : active?.database) ?? store.connection(connectionId)?.database ?? null,
      sql: detail?.sql ?? '',
      runOnOpen: detail?.run,
    };
    this.tabs = [...this.tabs, tab];
    this.activate(tab.id);
    this.persist();
  }

  private async activate(id: string) {
    this.activeId = id;
    await this.updateComplete;
    this.renderRoot.querySelector<OqQueryTab>('oq-query-tab[active]')?.focusEditor();
  }

  private close(id: string) {
    const i = this.tabs.findIndex((t) => t.id === id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.activeId === id) this.activeId = this.tabs[Math.min(i, this.tabs.length - 1)]?.id ?? null;
    this.persist();
  }

  private onOpenQuery = (e: CustomEvent<OpenQueryDetail>) => this.newTab(e.detail);

  private onEditConnection = (e: CustomEvent<EditConnectionDetail>) =>
    this.dialog.edit(e.detail.connectionId ? (store.connection(e.detail.connectionId) ?? null) : null);

  private onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      this.newTab();
    }
  };

  /** Tabs (connection, database, SQL text) survive reloads via localStorage. */
  private persist = () => {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(this.persistNow, 500);
    this.requestUpdate();
  };

  private persistNow = () => {
    // Pull latest editor text from each tab before saving.
    this.renderRoot.querySelectorAll<OqQueryTab>('oq-query-tab').forEach((el) => {
      const editor = el.shadowRoot?.querySelector('oq-sql-editor');
      if (editor) el.model.sql = editor.value;
    });
    const data = this.tabs.map(({ id, connectionId, database, sql }) => ({ id, connectionId, database, sql }));
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: data, activeId: this.activeId }));
  };
}

function restoreTabs(): { tabs: QueryTabModel[]; activeId: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null');
    return { tabs: Array.isArray(saved?.tabs) ? saved.tabs : [], activeId: saved?.activeId ?? null };
  } catch {
    return { tabs: [], activeId: null };
  }
}

customElements.define('oq-app', OqApp);

declare global {
  interface HTMLElementTagNameMap {
    'oq-app': OqApp;
  }
}
