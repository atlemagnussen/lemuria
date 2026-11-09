using System.Data.Common;
using Lemuria.Server.Connections;
using Lemuria.Server.Providers;
using Lemuria.Server.Query;

namespace Lemuria.Server.Api;

public static class Endpoints
{
    public static void MapLemuriaApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/providers", (ProviderRegistry registry) =>
            registry.All.Select(p => new { p.Key, p.DisplayName, p.DefaultPort }));

        var connections = api.MapGroup("/connections");

        connections.MapGet("/", async (ConnectionStore store, CancellationToken ct) =>
            (await store.ListAsync(ct)).Select(ConnectionDto.From));

        connections.MapPost("/", async (ConnectionInput input, ConnectionStore store, CancellationToken ct) =>
        {
            if (Validate(input) is { } problem) return problem;
            var saved = await store.SaveAsync(input with { Id = null }, ct);
            return Results.Ok(ConnectionDto.From(saved));
        });

        connections.MapPut("/{id:guid}", async (Guid id, ConnectionInput input, ConnectionStore store, CancellationToken ct) =>
        {
            if (Validate(input) is { } problem) return problem;
            if (await store.GetAsync(id, ct) is null) return Results.NotFound();
            var saved = await store.SaveAsync(input with { Id = id }, ct);
            return Results.Ok(ConnectionDto.From(saved));
        });

        connections.MapDelete("/{id:guid}", async (Guid id, ConnectionStore store, CancellationToken ct) =>
            await store.DeleteAsync(id, ct) ? Results.NoContent() : Results.NotFound());

        connections.MapPost("/test", async (ConnectionInput input, ConnectionStore store, QueryService query, CancellationToken ct) =>
        {
            if (Validate(input) is { } problem) return problem;
            try
            {
                var (_, conn) = await query.OpenAsync(await store.ResolveAsync(input, ct), ct);
                await using var _ = conn;
                return Results.Ok(new { ok = true, serverVersion = conn.ServerVersion });
            }
            catch (Exception ex) when (ex is DbException or InvalidOperationException or NotSupportedException)
            {
                return Results.Ok(new { ok = false, error = ex.Message });
            }
        });

        connections.MapGet("/{id:guid}/databases", async (Guid id, QueryService query, CancellationToken ct) =>
            await WithConnection(() => query.OpenForCatalogAsync(id, ct), (p, c) => p.GetDatabasesAsync(c, ct)));

        connections.MapGet("/{id:guid}/schema", async (Guid id, string? database, QueryService query, CancellationToken ct) =>
            await WithConnection(() => query.OpenAsync(id, database, ct), (p, c) => p.GetSchemaAsync(c, ct)));

        api.MapPost("/query", async (QueryRequest request, QueryService query, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.Sql)) return Results.BadRequest(new { error = "SQL is empty." });
            try
            {
                return Results.Ok(await query.ExecuteAsync(request, ct));
            }
            catch (KeyNotFoundException ex)
            {
                return Results.NotFound(new { error = ex.Message });
            }
            catch (DbException ex)
            {
                // Connection-level failures (login failed, server unreachable, ...)
                return Results.Ok(new QueryResponse([], [], 0, 0, new QueryError(ex.Message, null, null)));
            }
        });
    }

    private static async Task<IResult> WithConnection<T>(
        Func<Task<(IDbProvider Provider, DbConnection Connection)>> open,
        Func<IDbProvider, DbConnection, Task<T>> action)
    {
        try
        {
            var (provider, conn) = await open();
            await using var _ = conn;
            return Results.Ok(await action(provider, conn));
        }
        catch (KeyNotFoundException ex)
        {
            return Results.NotFound(new { error = ex.Message });
        }
        catch (DbException ex)
        {
            return Results.Problem(ex.Message, statusCode: StatusCodes.Status502BadGateway);
        }
    }

    private static IResult? Validate(ConnectionInput input)
    {
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(input.Name)) errors["name"] = ["Name is required."];
        if (string.IsNullOrWhiteSpace(input.Host)) errors["host"] = ["Host is required."];
        if (input.AuthType == "sql" && string.IsNullOrWhiteSpace(input.Username)) errors["username"] = ["Username is required."];
        return errors.Count > 0 ? Results.ValidationProblem(errors) : null;
    }
}
