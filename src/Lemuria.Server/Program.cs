using Microsoft.AspNetCore.DataProtection;
using OpenQuery.Server.Api;
using OpenQuery.Server.Connections;
using OpenQuery.Server.Providers;
using OpenQuery.Server.Query;
using OpenQuery.Server.Vite;

var builder = WebApplication.CreateBuilder(args);

var paths = new AppPaths(builder.Configuration);
builder.Services.AddSingleton(paths);
builder.Services.AddDataProtection()
    .SetApplicationName("OpenQuery")
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
app.MapOpenQueryApi();
app.MapRazorPages();

app.Run();
