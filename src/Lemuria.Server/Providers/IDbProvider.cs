using System.Data.Common;
using Lemuria.Server.Connections;

namespace Lemuria.Server.Providers;

/// <summary>
/// Everything engine-specific lives behind this interface. Query execution itself is generic
/// ADO.NET (see QueryService), so adding Postgres means: implement this with Npgsql and register it.
/// </summary>
public interface IDbProvider
{
    /// <summary>Key stored on the connection profile, e.g. "sqlserver".</summary>
    string Key { get; }
    string DisplayName { get; }
    int DefaultPort { get; }

    DbConnection CreateConnection(ResolvedConnection connection);

    Task<IReadOnlyList<string>> GetDatabasesAsync(DbConnection open, CancellationToken ct);

    Task<SchemaInfo> GetSchemaAsync(DbConnection open, CancellationToken ct);

    /// <summary>Split a script into batches (e.g. on GO for SQL Server). Each batch knows its starting line.</summary>
    IReadOnlyList<SqlBatch> SplitBatches(string sql);

    /// <summary>Wire up server messages (PRINT, RAISERROR low severity, NOTICE, ...).</summary>
    void OnMessage(DbConnection connection, Action<string> onMessage);

    /// <summary>Extract a friendly error (with line number when available) from a provider exception.</summary>
    QueryError? TryMapError(Exception ex, SqlBatch batch);
}

public sealed record SqlBatch(string Sql, int StartLine);

public sealed record SchemaInfo(IReadOnlyList<SchemaNode> Schemas);

public sealed record SchemaNode(string Name, IReadOnlyList<SchemaObject> Objects);

/// <summary>Type: "table" | "view".</summary>
public sealed record SchemaObject(string Name, string Type, IReadOnlyList<SchemaColumn> Columns);

public sealed record SchemaColumn(string Name, string DataType, bool Nullable, bool IsPrimaryKey);

public sealed record QueryError(string Message, int? Line, int? Number);

public sealed class ProviderRegistry(IEnumerable<IDbProvider> providers)
{
    private readonly Dictionary<string, IDbProvider> _byKey =
        providers.ToDictionary(p => p.Key, StringComparer.OrdinalIgnoreCase);

    public IEnumerable<IDbProvider> All => _byKey.Values;

    public IDbProvider Get(string key) =>
        _byKey.TryGetValue(key, out var p) ? p : throw new NotSupportedException($"Unknown provider '{key}'.");
}
