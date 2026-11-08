using Microsoft.AspNetCore.DataProtection;
using Lemuria.Server.Api;
using Lemuria.Server.Connections;
using Lemuria.Server.Providers;
using Lemuria.Server.Query;
using Lemuria.Server.Vite;

var builder = WebApplication.CreateBuilder(args);

var paths = new AppPaths(builder.Configuration);
builder.Services.AddSingleton(paths);
builder.Services.AddDataProtection()
    .SetApplicationName("Lemuria")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(paths.DataDirectory, "keys")));

builder.Services.AddSingleton<IDbProvider, SqlServerProvider>();
builder.Services.AddSingleton<ProviderRegistry>();
builder.Services.AddSingleton<ConnectionStore>();
builder.Services.AddSingleton<QueryService>();
builder.Services.AddSingleton<ViteAssets>();
builder.Services.AddRazorPages();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);

var app = builder.Build();

app.UseStaticFiles();
app.MapLemuriaApi();
app.MapRazorPages();

app.Run();
