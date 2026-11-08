namespace Lemuria.Server.Connections;

/// <summary>A saved database connection. Password is stored encrypted (Data Protection).</summary>
public sealed class ConnectionProfile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    /// <summary>Provider key, e.g. "sqlserver" (later "postgres").</summary>
    public string Provider { get; set; } = "sqlserver";
    public string Host { get; set; } = "";
    public int? Port { get; set; }
    public string? Database { get; set; }
    /// <summary>Authentication type. Only "sql" (username/password) for now.</summary>
    public string AuthType { get; set; } = "sql";
    public string? Username { get; set; }
    public string? ProtectedPassword { get; set; }
    public bool Encrypt { get; set; } = true;
    public bool TrustServerCertificate { get; set; }
}

/// <summary>Connection as exposed over the API — never includes the password.</summary>
public sealed record ConnectionDto(
    Guid Id,
    string Name,
    string Provider,
    string Host,
    int? Port,
    string? Database,
    string AuthType,
    string? Username,
    bool HasPassword,
    bool Encrypt,
    bool TrustServerCertificate)
{
    public static ConnectionDto From(ConnectionProfile p) => new(
        p.Id, p.Name, p.Provider, p.Host, p.Port, p.Database, p.AuthType, p.Username,
        !string.IsNullOrEmpty(p.ProtectedPassword), p.Encrypt, p.TrustServerCertificate);
}

/// <summary>Create/update/test payload. A null password on update keeps the stored one.</summary>
public sealed record ConnectionInput(
    Guid? Id,
    string Name,
    string Provider,
    string Host,
    int? Port,
    string? Database,
    string AuthType,
    string? Username,
    string? Password,
    bool Encrypt,
    bool TrustServerCertificate);

/// <summary>Fully resolved connection info handed to providers (plain-text password, in memory only).</summary>
public sealed record ResolvedConnection(
    string Provider,
    string Host,
    int? Port,
    string? Database,
    string AuthType,
    string? Username,
    string? Password,
    bool Encrypt,
    bool TrustServerCertificate);
