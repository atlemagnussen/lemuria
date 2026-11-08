using System.Data.Common;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Lemuria.Server.Connections;

namespace Lemuria.Server.Providers;

public sealed partial class SqlServerProvider : IDbProvider
{
    public string Key => "sqlserver";
    public string DisplayName => "SQL Server";
    public int DefaultPort => 1433;

    public DbConnection CreateConnection(ResolvedConnection c)
    {
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = c.Port is { } port && port != DefaultPort ? $"{c.Host},{port}" : c.Host,
            Encrypt = c.Encrypt ? SqlConnectionEncryptOption.Mandatory : SqlConnectionEncryptOption.Optional,
            TrustServerCertificate = c.TrustServerCertificate,
            ApplicationName = "Lemuria",
            ConnectTimeout = 15,
        };
        if (!string.IsNullOrWhiteSpace(c.Database)) builder.InitialCatalog = c.Database;

        switch (c.AuthType)
        {
            case "sql":
                builder.UserID = c.Username ?? "";
                builder.Password = c.Password ?? "";
                break;
            default:
                throw new NotSupportedException($"Authentication '{c.AuthType}' is not supported yet.");
        }

        return new SqlConnection(builder.ConnectionString);
    }

    public async Task<IReadOnlyList<string>> GetDatabasesAsync(DbConnection open, CancellationToken ct)
    {
        await using var cmd = open.CreateCommand();
        cmd.CommandText = "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name";
        var result = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) result.Add(reader.GetString(0));
        return result;
    }

    public async Task<SchemaInfo> GetSchemaAsync(DbConnection open, CancellationToken ct)
    {
        const string sql = """
            SELECT s.name, o.name, o.type, c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable,
                   CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit)
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            JOIN sys.columns c ON c.object_id = o.object_id
            JOIN sys.types t ON t.user_type_id = c.user_type_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM sys.indexes i
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
            ORDER BY s.name, o.name, c.column_id
            """;

        await using var cmd = open.CreateCommand();
        cmd.CommandText = sql;
        await using var reader = await cmd.ExecuteReaderAsync(ct);

        var schemas = new List<SchemaNode>();
        string? curSchema = null, curObject = null, curType = null;
        List<SchemaObject>? objects = null;
        List<SchemaColumn>? columns = null;

        void FlushObject()
        {
            if (curObject is not null) objects!.Add(new SchemaObject(curObject, curType!, columns!));
            curObject = null;
        }

        while (await reader.ReadAsync(ct))
        {
            var schema = reader.GetString(0);
            var obj = reader.GetString(1);
            if (schema != curSchema)
            {
                FlushObject();
                curSchema = schema;
                objects = [];
                schemas.Add(new SchemaNode(schema, objects));
            }
            if (obj != curObject)
            {
                FlushObject();
                curObject = obj;
                curType = reader.GetString(2).Trim() == "V" ? "view" : "table";
                columns = [];
            }
            columns!.Add(new SchemaColumn(
                reader.GetString(3),
                FormatType(reader.GetString(4), reader.GetInt16(5), reader.GetByte(6), reader.GetByte(7)),
                reader.GetBoolean(8),
                reader.GetBoolean(9)));
        }
        FlushObject();
        return new SchemaInfo(schemas);
    }

    private static string FormatType(string type, short maxLength, byte precision, byte scale) => type switch
    {
        "varchar" or "char" or "varbinary" or "binary" => $"{type}({(maxLength == -1 ? "max" : maxLength)})",
        "nvarchar" or "nchar" => $"{type}({(maxLength == -1 ? "max" : maxLength / 2)})",
        "decimal" or "numeric" => $"{type}({precision},{scale})",
        "datetime2" or "time" or "datetimeoffset" => $"{type}({scale})",
        _ => type,
    };

    [GeneratedRegex(@"^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex GoLine();

    public IReadOnlyList<SqlBatch> SplitBatches(string sql)
    {
        var batches = new List<SqlBatch>();
        var current = new StringBuilder();
        var startLine = 1;
        var lines = sql.Replace("\r\n", "\n").Split('\n');

        for (var i = 0; i < lines.Length; i++)
        {
            var match = GoLine().Match(lines[i]);
            if (match.Success)
            {
                var repeat = match.Groups[1].Success ? int.Parse(match.Groups[1].Value) : 1;
                if (current.ToString().Trim().Length > 0)
                    for (var r = 0; r < repeat; r++) batches.Add(new SqlBatch(current.ToString(), startLine));
                current.Clear();
                startLine = i + 2;
                continue;
            }
            current.Append(lines[i]).Append('\n');
        }

        if (current.ToString().Trim().Length > 0) batches.Add(new SqlBatch(current.ToString(), startLine));
        return batches;
    }

    public void OnMessage(DbConnection connection, Action<string> onMessage)
    {
        if (connection is SqlConnection sql)
            sql.InfoMessage += (_, e) =>
            {
                foreach (SqlError err in e.Errors) onMessage(err.Message);
            };
    }

    public QueryError? TryMapError(Exception ex, SqlBatch batch) => ex is SqlException sqlEx
        ? new QueryError(sqlEx.Message, batch.StartLine + Math.Max(sqlEx.LineNumber, 1) - 1, sqlEx.Number)
        : null;
}
