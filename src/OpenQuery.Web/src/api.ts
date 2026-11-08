// Typed client for the .NET API. Keep in sync with OpenQuery.Server/Api/Endpoints.cs.

export interface Connection {
  id: string;
  name: string;
  provider: string;
  host: string;
  port: number | null;
  database: string | null;
  authType: 'sql';
  username: string | null;
  hasPassword: boolean;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export interface ConnectionInput {
  id?: string | null;
  name: string;
  provider: string;
  host: string;
  port: number | null;
  database: string | null;
  authType: 'sql';
  username: string | null;
  /** null keeps the stored password on update. */
  password: string | null;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export interface Provider {
  key: string;
  displayName: string;
  defaultPort: number;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}
export interface SchemaObject {
  name: string;
  type: 'table' | 'view';
  columns: SchemaColumn[];
}
export interface SchemaNode {
  name: string;
  objects: SchemaObject[];
}
export interface SchemaInfo {
  schemas: SchemaNode[];
}

export type CellValue = string | number | boolean | null;

export interface ResultSet {
  columns: { name: string; type: string }[];
  rows: CellValue[][];
  truncated: boolean;
}

export interface QueryError {
  message: string;
  line: number | null;
  number: number | null;
}

export interface QueryResponse {
  resultSets: ResultSet[];
  messages: string[];
  recordsAffected: number;
  elapsedMs: number;
  error: QueryError | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      (typeof data === 'object' && data && ('error' in data ? data.error : 'detail' in data ? data.detail : data.title)) ||
      res.statusText;
    throw new ApiError(String(msg), res.status, data);
  }
  return data as T;
}

export const api = {
  providers: () => request<Provider[]>('GET', '/api/providers'),
  listConnections: () => request<Connection[]>('GET', '/api/connections'),
  createConnection: (c: ConnectionInput) => request<Connection>('POST', '/api/connections', c),
  updateConnection: (id: string, c: ConnectionInput) => request<Connection>('PUT', `/api/connections/${id}`, c),
  deleteConnection: (id: string) => request<void>('DELETE', `/api/connections/${id}`),
  testConnection: (c: ConnectionInput) =>
    request<{ ok: boolean; serverVersion?: string; error?: string }>('POST', '/api/connections/test', c),
  databases: (id: string) => request<string[]>('GET', `/api/connections/${id}/databases`),
  schema: (id: string, database: string | null) =>
    request<SchemaInfo>(
      'GET',
      `/api/connections/${id}/schema${database ? `?database=${encodeURIComponent(database)}` : ''}`,
    ),
  query: (connectionId: string, database: string | null, sql: string, signal?: AbortSignal) =>
    request<QueryResponse>('POST', '/api/query', { connectionId, database, sql }, signal),
};
