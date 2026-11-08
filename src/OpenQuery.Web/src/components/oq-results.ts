import { LitElement, css, html, nothing } from 'lit';
import type { QueryResponse } from '../api.js';
import './oq-data-grid.js';

/** Bottom panel: one tab per result set plus a Messages tab, and a status bar. */
export class OqResults extends LitElement {
  static properties = {
    response: { attribute: false },
    running: { type: Boolean },
    failure: {},
    active: { state: true },
  };

  declare response: QueryResponse | null;
  declare running: boolean;
  /** Transport-level failure (network, server error) — distinct from SQL errors in response.error. */
  declare failure: string | null;
  declare active: number; // -1 = messages

  constructor() {
    super();
    this.response = null;
    this.running = false;
    this.failure = null;
    this.active = 0;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--wa-color-surface-default);
    }
    .tabs {
      display: flex;
      gap: 2px;
      padding: 0 var(--wa-space-xs);
      border-bottom: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-lowered);
      overflow-x: auto;
      flex: none;
    }
    .tab {
      all: unset;
      padding: 6px 12px;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
      border-bottom: 2px solid transparent;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab:hover {
      color: var(--wa-color-text-normal);
    }
    .tab[aria-selected='true'] {
      color: var(--wa-color-text-normal);
      border-bottom-color: var(--wa-color-brand-fill-loud);
    }
    .tab .count {
      color: var(--wa-color-text-quiet);
      margin-left: 4px;
    }
    .body {
      position: relative;
      flex: 1;
      min-height: 0;
    }
    oq-data-grid {
      position: absolute;
      inset: 0;
    }
    .messages {
      position: absolute;
      inset: 0;
      overflow: auto;
      padding: var(--wa-space-s) var(--wa-space-m);
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s);
    }
    .messages div {
      white-space: pre-wrap;
    }
    .messages .error {
      margin-top: var(--wa-space-s);
      color: var(--wa-color-danger-fill-loud);
    }
    .placeholder {
      display: grid;
      place-items: center;
      height: 100%;
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      gap: var(--wa-space-s);
    }
    .status {
      display: flex;
      gap: var(--wa-space-m);
      align-items: center;
      padding: 3px var(--wa-space-s);
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
      border-top: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-lowered);
      flex: none;
    }
    .status .err {
      color: var(--wa-color-danger-fill-loud);
    }
    .status .warn {
      color: var(--wa-color-warning-fill-loud, orange);
    }
  `;

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('response') && this.response) {
      const hasSets = this.response.resultSets.length > 0;
      this.active = hasSets && !this.response.error ? 0 : -1;
    }
  }

  render() {
    const r = this.response;
    if (this.running && !r) return html`<div class="placeholder"><wa-spinner></wa-spinner>Executing…</div>`;
    if (this.failure) return html`<div class="messages"><span class="error">${this.failure}</span></div>`;
    if (!r) return html`<div class="placeholder">Run a query with Ctrl+Enter or F5</div>`;

    const sets = r.resultSets;
    const set = this.active >= 0 ? sets[this.active] : null;
    const totalRows = sets.reduce((n, s) => n + s.rows.length, 0);

    return html`
      <div class="tabs" role="tablist">
        ${sets.map(
          (s, i) => html`
            <button class="tab" role="tab" aria-selected=${this.active === i} @click=${() => (this.active = i)}>
              Result ${sets.length > 1 ? i + 1 : ''}<span class="count">${s.rows.length.toLocaleString()}</span>
            </button>
          `,
        )}
        <button class="tab" role="tab" aria-selected=${this.active === -1} @click=${() => (this.active = -1)}>
          Messages${r.error ? html` <span class="count" style="color:var(--wa-color-danger-fill-loud)">●</span>` : nothing}
        </button>
      </div>
      <div class="body">
        ${set
          ? html`<oq-data-grid .columns=${set.columns} .rows=${set.rows}></oq-data-grid>`
          : html`<div class="messages">${this.renderMessages(r)}</div>`}
      </div>
      <div class="status">
        ${this.running ? html`<span>Executing…</span>` : nothing}
        ${r.error ? html`<span class="err">Error</span>` : html`<span>Done</span>`}
        <span>${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'}</span>
        ${r.recordsAffected > 0 ? html`<span>${r.recordsAffected.toLocaleString()} affected</span>` : nothing}
        ${set?.truncated ? html`<span class="warn">Truncated to ${set.rows.length.toLocaleString()} rows</span>` : nothing}
        <span style="margin-left:auto">${formatElapsed(r.elapsedMs)}</span>
      </div>
    `;
  }

  private renderMessages(r: QueryResponse) {
    const lines = [...r.messages];
    if (r.recordsAffected > 0) lines.push(`(${r.recordsAffected} row(s) affected)`);
    r.resultSets.forEach((s) => lines.push(`(${s.rows.length} row(s) returned${s.truncated ? ', truncated' : ''})`));
    if (!lines.length && !r.error) lines.push('Commands completed successfully.');
    const e = r.error;
    const header = e?.number ? `Msg ${e.number}${e.line ? `, Line ${e.line}` : ''}` : null;
    return html`${lines.map((l) => html`<div>${l}</div>`)}${e
      ? html`<div class="error">${header ? html`<div>${header}</div>` : nothing}<div>${e.message}</div></div>`
      : nothing}`;
  }
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(2)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

customElements.define('oq-results', OqResults);

declare global {
  interface HTMLElementTagNameMap {
    'oq-results': OqResults;
  }
}
