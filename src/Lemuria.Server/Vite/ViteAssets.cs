using System.Text.Json;

namespace OpenQuery.Server.Vite;

/// <summary>
/// Resolves the frontend entry for the Razor host page.
/// Development (Vite:DevServerUrl set): load modules straight from the Vite dev server (HMR).
/// Otherwise: read wwwroot/app/.vite/manifest.json produced by `vite build`.
/// </summary>
public sealed class ViteAssets(IWebHostEnvironment env, IConfiguration config)
{
    private const string Entry = "src/main.ts";
    private const string BasePath = "/app/";
    private Manifest? _cached;
    private DateTime _cachedAt;

    public string? DevServerUrl => env.IsDevelopment() ? config["Vite:DevServerUrl"]?.TrimEnd('/') : null;

    public sealed record Manifest(string Script, IReadOnlyList<string> Styles);

    public Manifest GetManifest()
    {
        var file = Path.Combine(env.WebRootPath, "app", ".vite", "manifest.json");
        var stamp = File.GetLastWriteTimeUtc(file);
        if (_cached is not null && stamp == _cachedAt) return _cached; // re-read after `vite build --watch` rebuilds

        if (!File.Exists(file))
            throw new FileNotFoundException(
                "Frontend not built. Run `npm run build` in src/OpenQuery.Web (or set Vite:DevServerUrl and run `npm run dev`).", file);

        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        var entry = doc.RootElement.GetProperty(Entry);
        var styles = entry.TryGetProperty("css", out var css)
            ? css.EnumerateArray().Select(c => BasePath + c.GetString()).ToList()
            : [];
        _cachedAt = stamp;
        return _cached = new Manifest(BasePath + entry.GetProperty("file").GetString(), styles);
    }
}
