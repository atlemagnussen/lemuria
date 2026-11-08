using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace OpenQuery.Server.Connections;

/// <summary>Persists connection profiles as JSON in the app data directory.</summary>
public sealed class ConnectionStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _file;
    private readonly IDataProtector _protector;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<ConnectionProfile>? _cache;

    public ConnectionStore(AppPaths paths, IDataProtectionProvider dataProtection)
    {
        _file = Path.Combine(paths.DataDirectory, "connections.json");
        _protector = dataProtection.CreateProtector("OpenQuery.Connections.Password.v1");
    }

    public async Task<IReadOnlyList<ConnectionProfile>> ListAsync(CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try { return [.. (await LoadAsync(ct)).OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase)]; }
        finally { _lock.Release(); }
    }

    public async Task<ConnectionProfile?> GetAsync(Guid id, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try { return (await LoadAsync(ct)).FirstOrDefault(c => c.Id == id); }
        finally { _lock.Release(); }
    }

    public async Task<ConnectionProfile> SaveAsync(ConnectionInput input, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var all = await LoadAsync(ct);
            var profile = input.Id is { } id ? all.FirstOrDefault(c => c.Id == id) : null;
            if (profile is null)
            {
                profile = new ConnectionProfile { Id = input.Id ?? Guid.NewGuid() };
                all.Add(profile);
            }

            profile.Name = input.Name.Trim();
            profile.Provider = input.Provider;
            profile.Host = input.Host.Trim();
            profile.Port = input.Port;
            profile.Database = string.IsNullOrWhiteSpace(input.Database) ? null : input.Database.Trim();
            profile.AuthType = input.AuthType;
            profile.Username = input.Username;
            profile.Encrypt = input.Encrypt;
            profile.TrustServerCertificate = input.TrustServerCertificate;
            if (input.Password is not null)
                profile.ProtectedPassword = input.Password.Length == 0 ? null : _protector.Protect(input.Password);

            await PersistAsync(all, ct);
            return profile;
        }
        finally { _lock.Release(); }
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var all = await LoadAsync(ct);
            if (all.RemoveAll(c => c.Id == id) == 0) return false;
            await PersistAsync(all, ct);
            return true;
        }
        finally { _lock.Release(); }
    }

    public ResolvedConnection Resolve(ConnectionProfile p, string? databaseOverride = null) => new(
        p.Provider, p.Host, p.Port, databaseOverride ?? p.Database, p.AuthType, p.Username,
        p.ProtectedPassword is null ? null : _protector.Unprotect(p.ProtectedPassword),
        p.Encrypt, p.TrustServerCertificate);

    /// <summary>Resolve an unsaved input (used by "Test connection"); falls back to the stored password.</summary>
    public async Task<ResolvedConnection> ResolveAsync(ConnectionInput input, CancellationToken ct = default)
    {
        var password = input.Password;
        if (password is null && input.Id is { } id && await GetAsync(id, ct) is { ProtectedPassword: { } pp })
            password = _protector.Unprotect(pp);

        return new ResolvedConnection(input.Provider, input.Host, input.Port, input.Database, input.AuthType,
            input.Username, password, input.Encrypt, input.TrustServerCertificate);
    }

    private async Task<List<ConnectionProfile>> LoadAsync(CancellationToken ct)
    {
        if (_cache is not null) return _cache;
        if (!File.Exists(_file)) return _cache = [];
        await using var stream = File.OpenRead(_file);
        _cache = await JsonSerializer.DeserializeAsync<List<ConnectionProfile>>(stream, JsonOptions, ct) ?? [];
        return _cache;
    }

    private async Task PersistAsync(List<ConnectionProfile> all, CancellationToken ct)
    {
        var tmp = _file + ".tmp";
        await using (var stream = File.Create(tmp))
            await JsonSerializer.SerializeAsync(stream, all, JsonOptions, ct);
        File.Move(tmp, _file, overwrite: true);
    }
}

public sealed class AppPaths
{
    public string DataDirectory { get; }

    public AppPaths(IConfiguration config)
    {
        var configured = config["OpenQuery:DataDirectory"];
        DataDirectory = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenQuery")
            : configured;
        Directory.CreateDirectory(DataDirectory);
    }
}
