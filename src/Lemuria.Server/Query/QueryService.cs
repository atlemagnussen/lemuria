using System.Collections;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using Lemuria.Server.Connections;
using Lemuria.Server.Providers;

namespace Lemuria.Server.Query;

public sealed record QueryRequest(Guid ConnectionId, string? Database, string Sql, int? MaxRows);

public sealed record ColumnInfo(string Name, string Type);

public sealed record ResultSet(IReadOnlyList<ColumnInfo> Columns, List<object?[]> Rows, bool Truncated);

public sealed record QueryResponse(
    IReadOnlyList<ResultSet> ResultSets,
    IReadOnlyList<string> Messages,
    int RecordsAffected,
    long ElapsedMs,
    QueryError? Error);

/// <summary>Opens connections via the provider and runs scripts using plain ADO.NET.</summary>
public sealed class QueryService(ConnectionStore store, ProviderRegistry providers, IConfiguration config)
{
    private const long MaxSafeJsInteger = 9_007_199_254_740_991;
    private const int MaxBinaryBytesShown = 512;

    public async Task<(IDbProvider Provider, DbConnection Connection)> OpenAsync(
        ResolvedConnection resolved, CancellationToken ct)
    {
        var provider = providers.Get(resolved.Provider);
        var connection = provider.CreateConnection(resolved);
        try
        {
            await connection.OpenAsync(ct);
            return (provider, connection);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    public async Task<(IDbProvider Provider, DbConnection Connection)> OpenAsync(
        Guid connectionId, string? database, CancellationToken ct)
    {
        var profile = await store.GetAsync(connectionId, ct)
                      ?? throw new KeyNotFoundException($"Connection {connectionId} not found.");
        return await OpenAsync(store.Resolve(profile, string.IsNullOrWhiteSpace(database) ? null : database), ct);
    }

    /// <summary>
    /// Open a connection suited to listing the server's databases: the provider's catalog database
    /// (e.g. master) when the login can reach it, otherwise the profile's own database.
    /// </summary>
    public async Task<(IDbProvider Provider, DbConnection Connection)> OpenForCatalogAsync(
        Guid connectionId, CancellationToken ct)
    {
        var profile = await store.GetAsync(connectionId, ct)
                      ?? throw new KeyNotFoundException($"Connection {connectionId} not found.");
        var catalog = providers.Get(profile.Provider).CatalogDatabase;
        if (catalog is not null && !string.Equals(catalog, profile.Database, StringComparison.OrdinalIgnoreCase))
        {
            try { return await OpenAsync(store.Resolve(profile, catalog), ct); }
            catch (DbException) { /* no access to the catalog database: fall back to the profile's */ }
        }
        return await OpenAsync(store.Resolve(profile), ct);
    }

    public async Task<QueryResponse> ExecuteAsync(QueryRequest request, CancellationToken ct)
    {
        var maxRows = request.MaxRows ?? config.GetValue("Lemuria:DefaultMaxRows", 10_000);
        var sw = Stopwatch.StartNew();
        var resultSets = new List<ResultSet>();
        var messages = new List<string>();
        var recordsAffected = 0;

        var (provider, connection) = await OpenAsync(request.ConnectionId, request.Database, ct);
        await using var _ = connection;
        provider.OnMessage(connection, messages.Add);

        foreach (var batch in provider.SplitBatches(request.Sql))
        {
            try
            {
                await using var cmd = connection.CreateCommand();
                cmd.CommandText = batch.Sql;
                cmd.CommandTimeout = 0; // user controls cancellation from the UI
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                do
                {
                    if (reader.FieldCount == 0) continue;
                    resultSets.Add(await ReadResultSetAsync(provider, reader, maxRows, ct));
                } while (await reader.NextResultAsync(ct));

                if (reader.RecordsAffected > 0) recordsAffected += reader.RecordsAffected;
            }
            catch (Exception ex) when (provider.TryMapError(ex, batch) is { } error)
            {
                return new QueryResponse(resultSets, messages, recordsAffected, sw.ElapsedMilliseconds, error);
            }
        }

        return new QueryResponse(resultSets, messages, recordsAffected, sw.ElapsedMilliseconds, null);
    }

    private static async Task<ResultSet> ReadResultSetAsync(IDbProvider provider, DbDataReader reader, int maxRows, CancellationToken ct)
    {
        var columns = new ColumnInfo[reader.FieldCount];
        for (var i = 0; i < columns.Length; i++)
            columns[i] = new ColumnInfo(reader.GetName(i), reader.GetDataTypeName(i));

        var rows = new List<object?[]>();
        var truncated = false;
        while (await reader.ReadAsync(ct))
        {
            if (rows.Count >= maxRows)
            {
                truncated = true;
                break;
            }
            var row = new object?[columns.Length];
            for (var i = 0; i < row.Length; i++) row[i] = ReadCell(provider, reader, i);
            rows.Add(row);
        }
        return new ResultSet(columns, rows, truncated);
    }

    /// <summary>Read one cell; a value that can't be converted shows as a warning instead of failing the query.</summary>
    private static object? ReadCell(IDbProvider provider, DbDataReader reader, int i)
    {
        try
        {
            return reader.IsDBNull(i) ? null : ToJsonValue(provider.ReadValue(reader, i));
        }
        catch (Exception ex) when (ex is InvalidCastException or OverflowException or NotSupportedException)
        {
            return $"⚠ {ex.Message}";
        }
    }

    /// <summary>Normalize ADO.NET values to something JSON/JS can represent without losing information.</summary>
    private static object? ToJsonValue(object value) => value switch
    {
        DBNull => null,
        bool or byte or short or int or float or double or string => value,
        long l => l is > MaxSafeJsInteger or < -MaxSafeJsInteger ? l.ToString(CultureInfo.InvariantCulture) : l,
        decimal d => d.ToString(CultureInfo.InvariantCulture),
        DateTime { Kind: DateTimeKind.Utc } dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture) + " +00:00",
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
        DateTimeOffset dto => dto.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF zzz", CultureInfo.InvariantCulture),
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TimeOnly t => t.ToString("HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
        TimeSpan ts => ts.ToString("c", CultureInfo.InvariantCulture),
        Guid g => g.ToString(),
        byte[] bytes => "0x" + Convert.ToHexString(bytes, 0, Math.Min(bytes.Length, MaxBinaryBytesShown))
                        + (bytes.Length > MaxBinaryBytesShown ? "…" : ""),
        BitArray bits => string.Concat(bits.Cast<bool>().Select(b => b ? '1' : '0')),
        Array array => FormatArray(array),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture),
    };

    /// <summary>Arrays (Postgres int[], text[], ...) in Postgres literal style: {1,2,NULL}.</summary>
    private static string FormatArray(Array array) =>
        "{" + string.Join(",", array.Cast<object?>().Select(v => v is null or DBNull ? "NULL" : ToJsonValue(v) switch
        {
            string s => s.Length == 0 || s.AsSpan().IndexOfAny("{},\" \\") >= 0 || s.Equals("NULL", StringComparison.OrdinalIgnoreCase)
                ? "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""
                : s,
            var other => Convert.ToString(other, CultureInfo.InvariantCulture),
        })) + "}";
}
