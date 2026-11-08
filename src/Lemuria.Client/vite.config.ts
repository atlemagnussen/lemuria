import { defineConfig } from 'vite';

// Dev: either browse the .NET app (http://localhost:5228, loads modules from this dev server)
// or browse Vite directly (http://localhost:5173, /api is proxied to .NET).
// Build: output goes into the ASP.NET wwwroot, consumed by Pages/Index.cshtml via the manifest.
export default defineConfig({
  base: '/app/',
  server: {
    port: 5173,
    strictPort: true,
    origin: 'http://localhost:5173',
    cors: true,
    proxy: {
      '/api': 'http://localhost:5228',
    },
  },
  build: {
    outDir: '../Lemuria.Server/wwwroot/app',
    emptyOutDir: true,
    manifest: true,
    target: 'es2022',
    // Single local bundle served by ASP.NET — size warning isn't meaningful here.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: 'src/main.ts',
    },
  },
});
