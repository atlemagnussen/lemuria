using System.Buffers.Binary;
using System.Data.Common;
using System.Text;
using Npgsql;
using NpgsqlTypes;
using Lemuria.Server.Connections;

namespace Lemuria.Server.Providers;

public sealed class PostgresProvider : IDbProvider
{
    public string Key => "postgres";
    public string DisplayName => "PostgreSQL";
    public int DefaultPort => 5432;

    public DbConnection CreateConnection(ResolvedConnection c)
    {
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = c.Host,
            Port = c.Port ?? DefaultPort,
            // Npgsql would default to a database named after the user, which usually doesn't exist.
            Database = string.IsNullOrWhiteSpace(c.Database) ? "postgres" : c.Database,
            // Encrypt off: use TLS when the server offers it. On: require it, and validate the
            // certificate unless "Trust server certificate" is ticked (Require skips validation).
            SslMode = !c.Encrypt ? SslMode.Prefer : c.TrustServerCertificate ? SslMode.Require : SslMode.VerifyFull,
            ApplicationName = "Lemuria",
            Timeout = 15,
            IncludeErrorDetail = true,
        };

        switch (c.AuthType)
        {
            case "sql":
                builder.Username = c.Username ?? "";
                builder.Password = c.Password ?? "";
                break;
            default:
                throw new NotSupportedException($"Authentication '{c.AuthType}' is not supported yet.");
        }

        return new NpgsqlConnection(builder.ConnectionString);
    }

    public async Task<IReadOnlyList<string>> GetDatabasesAsync(DbConnection open, CancellationToken ct)
    {
        await using var cmd = open.CreateCommand();
        cmd.CommandText = """
            SELECT datname FROM pg_database
            WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
            ORDER BY datname = 'postgres', datname
            """;
        var result = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) result.Add(reader.GetString(0));
        return result;
    }

    public async Task<SchemaInfo> GetSchemaAsync(DbConnection open, CancellationToken ct)
    {
        // Tables (incl. partitioned + foreign), views and materialized views; partitions themselves are hidden.
        const string sql = """
            SELECT n.nspname, c.relname, c.relkind::text, a.attname,
                   format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                   EXISTS (SELECT 1 FROM pg_index i
                           WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey))
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
              AND NOT c.relispartition
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg\_toast%'
              AND n.nspname NOT LIKE 'pg\_temp\_%'
              AND has_schema_privilege(n.oid, 'USAGE')
            ORDER BY n.nspname, c.relname, a.attnum
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
                curType = reader.GetString(2) is "v" or "m" ? "view" : "table";
                columns = [];
            }
            columns!.Add(new SchemaColumn(reader.GetString(3), reader.GetString(4), reader.GetBoolean(5), reader.GetBoolean(6)));
        }
        FlushObject();
        return new SchemaInfo(schemas);
    }

    /// <summary>
    /// Run statements one at a time (autocommit, like psql) rather than as one Npgsql multi-statement
    /// command, which would wrap them in an implicit transaction (breaking CREATE DATABASE, VACUUM, ...)
    /// and wouldn't tell us which statement an error position belongs to.
    /// </summary>
    public IReadOnlyList<SqlBatch> SplitBatches(string sql) => PostgresScript.Split(sql);

    public void OnMessage(DbConnection connection, Action<string> onMessage)
    {
        if (connection is NpgsqlConnection npg)
            npg.Notice += (_, e) => onMessage(e.Notice.MessageText);
    }

    public QueryError? TryMapError(Exception ex, SqlBatch batch)
    {
        if (ex is not PostgresException pg) return null;

        var message = $"{pg.SqlState}: {pg.MessageText}";
        if (!string.IsNullOrEmpty(pg.Detail)) message += $"\nDetail: {pg.Detail}";
        if (!string.IsNullOrEmpty(pg.Hint)) message += $"\nHint: {pg.Hint}";
        if (!string.IsNullOrEmpty(pg.Where)) message += $"\nWhere: {pg.Where}";

        return new QueryError(message, ErrorLine(pg, batch), null);
    }

    /// <summary>Postgres reports a 1-based character position within the statement; turn it into an editor line.</summary>
    private static int ErrorLine(PostgresException pg, SqlBatch batch) =>
        batch.StartLine + batch.Sql.AsSpan(0, Math.Clamp(pg.Position - 1, 0, batch.Sql.Length)).Count('\n');

    public object ReadValue(DbDataReader reader, int ordinal)
    {
        try
        {
            var value = reader.GetValue(ordinal);
            // interval maps to TimeSpan (as does time), so check the type name only for TimeSpans.
            return value is TimeSpan && reader.GetDataTypeName(ordinal) == "interval"
                ? FormatInterval(reader.GetFieldValue<NpgsqlInterval>(ordinal))
                : value;
        }
        catch (Exception ex) when (ex is InvalidCastException or OverflowException)
        {
            var type = reader.GetDataTypeName(ordinal);
            if (type == "interval") return FormatInterval(reader.GetFieldValue<NpgsqlInterval>(ordinal));    // has months
            if (type.StartsWith("numeric", StringComparison.Ordinal))                                          // NaN, ±Infinity, beyond decimal
            {
                using var stream = reader.GetStream(ordinal);
                return DecodeNumeric(stream);
            }
            throw;
        }
    }

    /// <summary>Postgres-style interval text, e.g. "1 year 2 mons 3 days -04:05:06.5".</summary>
    private static string FormatInterval(NpgsqlInterval iv)
    {
        int years = iv.Months / 12, months = iv.Months % 12;
        var parts = new List<string>(4);
        if (years != 0) parts.Add(years == 1 ? "1 year" : $"{years} years");
        if (months != 0) parts.Add(months == 1 ? "1 mon" : $"{months} mons");
        if (iv.Days != 0) parts.Add(iv.Days == 1 ? "1 day" : $"{iv.Days} days");

        if (iv.Time != 0 || parts.Count == 0)
        {
            var sign = iv.Time < 0 ? "-" : years < 0 || months < 0 || iv.Days < 0 ? "+" : "";
            var micros = Math.Abs(iv.Time);
            var seconds = micros / 1_000_000;
            var time = $"{sign}{seconds / 3600:00}:{seconds / 60 % 60:00}:{seconds % 60:00}";
            if (micros % 1_000_000 != 0) time += "." + (micros % 1_000_000).ToString("000000").TrimEnd('0');
            parts.Add(time);
        }
        return string.Join(' ', parts);
    }

    /// <summary>
    /// Decode numeric's binary wire format (ndigits, weight, sign, dscale, then base-10000 digits) to exact text.
    /// Used only for values System.Decimal can't hold.
    /// </summary>
    private static string DecodeNumeric(Stream stream)
    {
        var buffer = new byte[stream.Length];
        stream.ReadExactly(buffer);
        int Int16At(int offset) => (short)BinaryPrimitives.ReadUInt16BigEndian(buffer.AsSpan(offset));

        var ndigits = Int16At(0);
        var weight = Int16At(2);
        var sign = (ushort)Int16At(4);
        var dscale = Int16At(6);
        switch (sign)
        {
            case 0xC000: return "NaN";
            case 0xD000: return "Infinity";
            case 0xF000: return "-Infinity";
        }
        int Digit(int k) => k >= 0 && k < ndigits ? Int16At(8 + 2 * k) : 0;

        var sb = new StringBuilder();
        if (sign == 0x4000) sb.Append('-');
        if (weight < 0) sb.Append('0');
        for (var k = 0; k <= weight; k++)
            sb.Append(k == 0 ? Digit(k).ToString() : Digit(k).ToString("0000"));

        if (dscale > 0)
        {
            var fraction = new StringBuilder();
            for (var k = weight + 1; fraction.Length < dscale; k++) fraction.Append(Digit(k).ToString("0000"));
            sb.Append('.').Append(fraction, 0, dscale);
        }
        return sb.ToString();
    }
}
