import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { api, type Connection, type SchemaInfo } from './api.js';

/** Minimal app-wide store: connections + cached schema metadata. */
class AppStore extends EventTarget {
  connections: Connection[] = [];
  private schemas = new Map<string, Promise<SchemaInfo>>();

  async loadConnections() {
    this.connections = await api.listConnections();
    this.changed();
  }

  connection(id: string | null | undefined) {
    return this.connections.find((c) => c.id === id);
  }

  /** Cached per connection+database; used by the tree and by editor autocomplete. */
  schema(connectionId: string, database: string | null): Promise<SchemaInfo> {
    const key = `${connectionId}|${database ?? ''}`;
    let p = this.schemas.get(key);
    if (!p) {
      p = api.schema(connectionId, database);
      p.catch(() => this.schemas.delete(key));
      this.schemas.set(key, p);
    }
    return p;
  }

  invalidateSchema(connectionId: string) {
    for (const key of [...this.schemas.keys()]) if (key.startsWith(connectionId + '|')) this.schemas.delete(key);
    this.changed();
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }
}

export const store = new AppStore();

/** Re-render a Lit host whenever the store changes. */
export class StoreController implements ReactiveController {
  private onChange = () => this.host.requestUpdate();
  constructor(private host: ReactiveControllerHost) {
    host.addController(this);
  }
  hostConnected() {
    store.addEventListener('change', this.onChange);
  }
  hostDisconnected() {
    store.removeEventListener('change', this.onChange);
  }
}

// ---- Theme -----------------------------------------------------------------

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('wa-dark') ? 'dark' : 'light';
}

export function setTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('wa-dark', theme === 'dark');
  root.classList.toggle('wa-light', theme === 'light');
  localStorage.setItem('lm-theme', theme);
  window.dispatchEvent(new CustomEvent('lm-theme-change', { detail: theme }));
}

// ---- App events (bubble + composed so they cross shadow roots up to <lm-app>) ----

export interface OpenQueryDetail {
  connectionId: string;
  database: string | null;
  sql?: string;
  run?: boolean;
}

export interface EditConnectionDetail {
  connectionId: string | null;
}

declare global {
  interface HTMLElementEventMap {
    'lm-open-query': CustomEvent<OpenQueryDetail>;
    'lm-edit-connection': CustomEvent<EditConnectionDetail>;
  }
  interface WindowEventMap {
    'lm-theme-change': CustomEvent<Theme>;
  }
}

export function emit<K extends 'lm-open-query' | 'lm-edit-connection'>(
  from: EventTarget,
  type: K,
  detail: HTMLElementEventMap[K]['detail'],
) {
  from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
