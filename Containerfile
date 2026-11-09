# Lemuria: production container (Release build, no Vite dev server).
#
#   podman build -t lemuria -f Containerfile .
#   podman run -d --name lemuria -p 8080:8080 -v lemuria-data:/data lemuria
#
# Browse http://localhost:8080. Connection profiles and Data Protection keys live in /data,
# so keep that volume, or saved passwords can't be decrypted after the container is recreated.
# To reach a database on the host, use host.containers.internal (podman) or
# host.docker.internal (docker, add --add-host=host.docker.internal:host-gateway) as the host.

# --- Client: Lit/Vite bundle -> src/Lemuria.Server/wwwroot/app ---
FROM docker.io/library/node:24-bookworm-slim AS client
WORKDIR /src/src/Lemuria.Client
COPY src/Lemuria.Client/package.json src/Lemuria.Client/package-lock.json ./
RUN npm ci
COPY src/Lemuria.Client/ ./
RUN npm run build

# --- Server: dotnet publish ---
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /src/src/Lemuria.Server
COPY src/Lemuria.Server/Lemuria.Server.csproj ./
RUN dotnet restore
COPY src/Lemuria.Server/ ./
COPY --from=client /src/src/Lemuria.Server/wwwroot/app ./wwwroot/app
RUN dotnet publish -c Release -o /app --no-restore -p:SkipWebClientBuild=true

# --- Runtime ---
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=server /app ./
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS=8080 \
    Lemuria__DataDirectory=/data
RUN mkdir -p /data && chown $APP_UID /data
VOLUME /data
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Lemuria.Server.dll"]
