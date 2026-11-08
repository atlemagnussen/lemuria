# Lemuria

This will be a tool for querying databases

Will start with SQL Server

The name is not decided yet, so "open-query" is mainly a placeholder for now.

## Features

Follow a Classic left menu - main window to the right layout.

- Define SQL Server connections (later support postgres so keep it general)
- Authenticate with SQL user
- Query with autocomplete
- Display results in grid

## Getting started

Requirements: .NET 10 SDK, Node 20+.

```bash
cd src/OpenQuery.Web && npm install
```

### Develop (hot reload)

Run both, then browse **http://localhost:5228** (the Razor page loads modules from the Vite dev server):

```bash
cd src/OpenQuery.Server && dotnet watch      # API + host page on :5228
cd src/OpenQuery.Web && npm run dev          # Vite on :5173
```

`http://localhost:5173/app/` also works on its own; it proxies `/api` to :5228.

### Build / ship

```bash
cd src/OpenQuery.Server && dotnet publish -c Release -o out
```

The publish step runs `npm run build`, which writes the client to `wwwroot/app`. The Razor page reads `wwwroot/app/.vite/manifest.json` to find the hashed bundle. You can also run `npm run build` by hand and then `dotnet run` with `ASPNETCORE_ENVIRONMENT=Production`.

### Test database

```bash
docker run -d --name oq-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=OpenQuery!Dev123' \
  -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
```

Connect with host `localhost`, port `14333`, user `sa`, and tick _Trust server certificate_.

## Architecture

```
src/
  OpenQuery.Server/          ASP.NET Core (.NET 10)
    Api/Endpoints.cs         Minimal API: /api/connections, /databases, /schema, /query
    Connections/             Profiles stored as JSON in %LOCALAPPDATA%/OpenQuery (password encrypted via Data Protection)
    Providers/               IDbProvider: everything engine-specific (SQL Server today, Postgres next)
    Query/QueryService.cs    Generic ADO.NET execution: batches, multiple result sets, messages, row cap, cancellation
    Pages/Index.cshtml       Host page that loads the custom elements (Vite dev server or built manifest)
  OpenQuery.Web/             Lit + Web Awesome custom elements, built by Vite into ../OpenQuery.Server/wwwroot/app
    components/oq-app        Shell: header, theme toggle, split layout, query tabs (persisted in localStorage)
    components/oq-connection-tree   Object explorer (lazy: connection → database → tables/views → columns)
    components/oq-connection-dialog Create/edit/test connections
    components/oq-query-tab  Toolbar + editor + results for one query
    components/oq-sql-editor CodeMirror 6 + @codemirror/lang-sql with schema/alias-aware autocomplete
    components/oq-data-grid  Custom virtualized grid (row recycling, sort, resize, range select, copy as TSV)
```

### Adding Postgres

1. `dotnet add package Npgsql`
2. Implement `IDbProvider` (connection string, databases, schema query, `OnMessage` via `NoticeReceived`, error mapping). Batch splitting is a no-op.
3. Register it in `Program.cs` and enable the option in `oq-connection-dialog`. The editor already maps `postgres` to the PostgreSQL dialect.

### Shortcuts

| Key                                            | Action                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Ctrl+Enter / F5                                | Run the selection, or the whole editor if nothing is selected |
| Ctrl+Space                                     | Autocomplete                                                  |
| Ctrl+Alt+N                                     | New query tab                                                 |
| Grid: Ctrl+C / Ctrl+Shift+C                    | Copy the selection (Ctrl+Shift+C includes headers)            |
| Grid: click header / drag or double-click edge | Sort / resize / auto-fit                                      |
