import { LitElement, css, html, nothing } from 'lit';
import { api, ApiError, type Connection, type ConnectionInput } from '../api.js';
import { store } from '../store.js';

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; version?: string } | { kind: 'error'; message: string };

const blank = (): ConnectionInput => ({
  id: null,
  name: '',
  provider: 'sqlserver',
  host: 'localhost',
  port: null,
  database: null,
  authType: 'sql',
  username: '',
  password: '',
  encrypt: true,
  trustServerCertificate: false,
});

/** Create / edit a connection. Open with `edit(connection | null)`. */
export class LmConnectionDialog extends LitElement {
  static properties = {
    open: { state: true },
    form: { state: true },
    existing: { state: true },
    test: { state: true },
    saving: { state: true },
    error: { state: true },
  };

  declare open: boolean;
  declare form: ConnectionInput;
  declare existing: Connection | null;
  declare test: TestState;
  declare saving: boolean;
  declare error: string | null;

  constructor() {
    super();
    this.open = false;
    this.form = blank();
    this.existing = null;
    this.test = { kind: 'idle' };
    this.saving = false;
    this.error = null;
  }

  static styles = css`
    form {
      display: grid;
      grid-template-columns: 1fr 120px;
      gap: var(--wa-space-m);
    }
    .full {
      grid-column: 1 / -1;
    }
    .checks {
      display: flex;
      gap: var(--wa-space-l);
    }
    .test {
      font-size: var(--wa-font-size-s);
    }
    .test.ok {
      color: var(--wa-color-success-fill-loud, green);
    }
    .test.error {
      color: var(--wa-color-danger-fill-loud);
    }
    .footer {
      display: flex;
      gap: var(--wa-space-s);
      width: 100%;
      align-items: center;
    }
    .footer .spacer {
      flex: 1;
    }
  `;

  edit(connection: Connection | null) {
    this.existing = connection;
    this.form = connection ? { ...connection, password: null } : blank();
    this.test = { kind: 'idle' };
    this.error = null;
    this.open = true;
  }

  render() {
    const f = this.form;
    const isEdit = !!this.existing;
    return html`
      <wa-dialog label=${isEdit ? `Edit connection` : 'New connection'} ?open=${this.open} @wa-after-hide=${this.onHide} style="--width: 34rem">
        <form id="form" @submit=${this.save} @input=${() => (this.test = { kind: 'idle' })}>
          <wa-input class="full" label="Name" required .value=${f.name} @input=${this.bind('name')} autofocus></wa-input>
          <wa-select class="full" label="Type" .value=${f.provider} @change=${this.bind('provider')}>
            <wa-option value="sqlserver">SQL Server</wa-option>
            <wa-option value="postgres" disabled>PostgreSQL (coming)</wa-option>
          </wa-select>
          <wa-input label="Host" required .value=${f.host} @input=${this.bind('host')}></wa-input>
          <wa-input label="Port" type="number" placeholder="1433" .value=${f.port?.toString() ?? ''} @input=${this.bindPort}></wa-input>
          <wa-input class="full" label="Default database" placeholder="(server default)" .value=${f.database ?? ''} @input=${this.bind('database')}></wa-input>
          <wa-input label="Username" required autocomplete="off" .value=${f.username ?? ''} @input=${this.bind('username')}></wa-input>
          <div></div>
          <wa-input
            class="full"
            label="Password"
            type="password"
            password-toggle
            autocomplete="new-password"
            placeholder=${isEdit && this.existing?.hasPassword ? '(unchanged)' : ''}
            .value=${f.password ?? ''}
            @input=${(e: Event) => (this.form = { ...this.form, password: (e.target as HTMLInputElement).value })}
          ></wa-input>
          <div class="full checks">
            <wa-checkbox ?checked=${f.encrypt} @change=${this.bindCheck('encrypt')}>Encrypt</wa-checkbox>
            <wa-checkbox ?checked=${f.trustServerCertificate} @change=${this.bindCheck('trustServerCertificate')}>Trust server certificate</wa-checkbox>
          </div>
          ${this.error ? html`<wa-callout class="full" variant="danger">${this.error}</wa-callout>` : nothing}
        </form>
        <div slot="footer" class="footer">
          <wa-button appearance="outlined" ?loading=${this.test.kind === 'testing'} @click=${this.runTest}>Test</wa-button>
          ${this.renderTest()}
          <span class="spacer"></span>
          <wa-button appearance="plain" @click=${() => (this.open = false)}>Cancel</wa-button>
          <wa-button variant="brand" ?loading=${this.saving} @click=${this.save}>Save</wa-button>
        </div>
      </wa-dialog>
    `;
  }

  private renderTest() {
    switch (this.test.kind) {
      case 'ok':
        return html`<span class="test ok">✓ Connected${this.test.version ? ` (v${this.test.version})` : ''}</span>`;
      case 'error':
        return html`<span class="test error" title=${this.test.message}>✗ ${truncate(this.test.message, 60)}</span>`;
      default:
        return nothing;
    }
  }

  private bind = (key: keyof ConnectionInput) => (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    this.form = { ...this.form, [key]: key === 'database' && !value ? null : value };
  };

  private bindCheck = (key: 'encrypt' | 'trustServerCertificate') => (e: Event) => {
    this.form = { ...this.form, [key]: (e.target as HTMLInputElement).checked };
  };

  private bindPort = (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    this.form = { ...this.form, port: v ? Number(v) : null };
  };

  private input(): ConnectionInput {
    return { ...this.form, id: this.existing?.id ?? null };
  }

  private runTest = async () => {
    this.test = { kind: 'testing' };
    try {
      const res = await api.testConnection(this.input());
      this.test = res.ok ? { kind: 'ok', version: res.serverVersion } : { kind: 'error', message: res.error ?? 'Failed' };
    } catch (e) {
      this.test = { kind: 'error', message: errorText(e) };
    }
  };

  private save = async (e: Event) => {
    e.preventDefault();
    if (this.saving) return;
    this.saving = true;
    this.error = null;
    try {
      const input = this.input();
      const saved = this.existing ? await api.updateConnection(this.existing.id, input) : await api.createConnection(input);
      await store.loadConnections();
      store.invalidateSchema(saved.id);
      this.dispatchEvent(new CustomEvent('lm-connection-saved', { detail: saved, bubbles: true, composed: true }));
      this.open = false;
    } catch (err) {
      this.error = errorText(err);
    } finally {
      this.saving = false;
    }
  };

  private onHide = (e: Event) => {
    // wa-after-hide bubbles from nested components (e.g. select menus) — only react to the dialog itself.
    if (e.target === e.currentTarget) this.open = false;
  };
}

function errorText(e: unknown) {
  if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'errors' in e.details) {
    return Object.values(e.details.errors as Record<string, string[]>).flat().join(' ');
  }
  return e instanceof Error ? e.message : String(e);
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

customElements.define('lm-connection-dialog', LmConnectionDialog);

declare global {
  interface HTMLElementTagNameMap {
    'lm-connection-dialog': LmConnectionDialog;
  }
}
