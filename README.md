# Lemuria

This will be a tool for querying databases

Will start with SQL Server

The project is named **Lemuria**.

## Features

Follow a Classic left menu - main window to the right layout.

- Define SQL Server connections (later support postgres so keep it general)
- Authenticate with SQL user
- Query with autocomplete
- Display results in grid

## Getting started

Requirements: .NET 10 SDK, Node 20+.

```bash
cd src/Lemuria.Client && npm install
```

### Develop (hot reload)

Quick start: `./run.sh` from the repo root starts both and Ctrl+C stops both. Or run them separately:

Run both, then browse **http://localhost:5228** (the Razor page loads modules from the Vite dev server):

```bash
cd src/Lemuria.Server && dotnet watch      # API + host page on :5228
cd src/Lemuria.Client && npm run dev          # Vite on :5173
```

`http://localhost:5173/app/` also works on its own; it proxies `/api` to :5228.

### Build / ship

```bash
cd src/Lemuria.Server && dotnet publish -c Release -o out
```

The publish step runs `npm run build`, which writes the client to `wwwroot/app`. The Razor page reads `wwwroot/app/.vite/manifest.json` to find the hashed bundle. You can also run `npm run build` by hand and then `dotnet run` with `ASPNETCORE_ENVIRONMENT=Production`.

### Test database

```bash
docker run -d --name lm-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Lemuria!Dev123' \
  -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
```

Connect with host `localhost`, port `14333`, user `sa`, and tick _Trust server certificate_.

## Architecture

```
src/
  Lemuria.Server/          ASP.NET Core (.NET 10)
    Api/Endpoints.cs         Minimal API: /api/connections, /databases, /schema, /query
    Connections/             Profiles stored as JSON in %LOCALAPPDATA%/Lemuria (password encrypted via Data Protection)
    Providers/               IDbProvider: everything engine-specific (SQL Server today, Postgres next)
    Query/QueryService.cs    Generic ADO.NET execution: batches, multiple result sets, messages, row cap, cancellation
    Pages/Index.cshtml       Host page that loads the custom elements (Vite dev server or built manifest)
  Lemuria.Client/             Lit + Web Awesome custom elements, built by Vite into ../Lemuria.Server/wwwroot/app
    components/lm-app        Shell: header, theme toggle, split layout, query tabs (persisted in localStorage)
    components/lm-connection-tree   Object explorer (lazy: connection → database → tables/views → columns)
    components/lm-connection-dialog Create/edit/test connections
    components/lm-query-tab  Toolbar + editor + results for one query
    components/lm-sql-editor CodeMirror 6 + @codemirror/lang-sql with schema/alias-aware autocomplete
    components/lm-data-grid  Custom virtualized grid (row recycling, sort, resize, range select, copy as TSV)
```

### Adding Postgres

1. `dotnet add package Npgsql`
2. Implement `IDbProvider` (connection string, databases, schema query, `OnMessage` via `NoticeReceived`, error mapping). Batch splitting is a no-op.
3. Register it in `Program.cs` and enable the option in `lm-connection-dialog`. The editor already maps `postgres` to the PostgreSQL dialect.

### Shortcuts

| Key                                            | Action                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Ctrl+Enter / F5                                | Run the selection, or the whole editor if nothing is selected |
| Ctrl+Space                                     | Autocomplete                                                  |
| Ctrl+Alt+N                                     | New query tab                                                 |
| Grid: Ctrl+C / Ctrl+Shift+C                    | Copy the selection (Ctrl+Shift+C includes headers)            |
| Grid: click header / drag or double-click edge | Sort / resize / auto-fit                                      |
