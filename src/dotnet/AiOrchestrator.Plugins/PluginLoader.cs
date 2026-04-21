// <copyright file="PluginLoader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plugins.Events;
using AiOrchestrator.Plugins.Loading;
using AiOrchestrator.Plugins.Trust;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plugins;

/// <summary>
/// Production implementation of <see cref="IPluginLoader"/>.
/// Discovers, trust-validates, and loads third-party plugins into isolated
/// <see cref="PluginLoadContext"/> instances (§3.10.2, §3.31.1.5).
/// </summary>
public sealed class PluginLoader : IPluginLoader, IAsyncDisposable
{
    private static readonly AuthContext SystemPrincipal = new()
    {
        PrincipalId = "system:plugin-loader",
        DisplayName = "Plugin Loader",
        Scopes = ImmutableArray.Create("audit.write"),
        IssuedAtUtc = DateTimeOffset.UtcNow,
    };

    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IAuditLog audit;
    private readonly IOptionsMonitor<PluginOptions> opts;
    private readonly ILogger<PluginLoader> logger;
    private readonly TrustFileVerifier trustVerifier;

    private readonly List<LoadedPlugin> loaded = [];
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="PluginLoader"/> class.</summary>
    /// <param name="fs">File system abstraction for reading manifests and trust files.</param>
    /// <param name="clock">Clock for timestamps on audit events.</param>
    /// <param name="bus">Event bus for publishing plugin lifecycle events.</param>
    /// <param name="audit">Audit log for security-relevant events.</param>
    /// <param name="opts">Options monitor supplying <see cref="PluginOptions"/>.</param>
    /// <param name="logger">Logger for diagnostic output.</param>
    public PluginLoader(
        IFileSystem fs,
        IClock clock,
        IEventBus bus,
        IAuditLog audit,
        IOptionsMonitor<PluginOptions> opts,
        ILogger<PluginLoader> logger)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
        this.trustVerifier = new TrustFileVerifier(fs);
    }

    /// <inheritdoc/>
    public IReadOnlyList<LoadedPlugin> Loaded => this.loaded.AsReadOnly();

    /// <inheritdoc/>
    public async ValueTask<ImmutableArray<LoadedPlugin>> DiscoverAndLoadAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(this.disposed, this);

        var options = this.opts.CurrentValue;
        var result = ImmutableArray.CreateBuilder<LoadedPlugin>();

        // --- Trust file validation (INV-1, INV-2) ---
        TrustFile? trustFile = null;
        if (options.RequireTrustFile)
        {
            var permsOk = await this.trustVerifier.IsTrustFileValidAsync(options.TrustFilePath, ct).ConfigureAwait(false);
            if (!permsOk)
            {
                this.logger.LogError("Trust file has invalid permissions: {Path}", options.TrustFilePath.Value);
                await this.bus.PublishAsync(
                    new PluginTrustFileInvalidPerms
                    {
                        TrustFilePath = options.TrustFilePath.Value,
                        DetectedAt = this.clock.UtcNow,
                    },
                    ct).ConfigureAwait(false);

                await this.AppendAuditAsync("PluginTrustFileInvalidPerms", $"{{\"path\":\"{options.TrustFilePath.Value}\"}}", ct).ConfigureAwait(false);
                throw new InvalidOperationException($"Trust file has invalid permissions (TRUST-ACL-1): {options.TrustFilePath.Value}");
            }

            if (options.TrustFileSignerPublicKey.Length == 0)
            {
                throw new InvalidOperationException("TrustFileSignerPublicKey must be set when RequireTrustFile is true.");
            }

            trustFile = await this.trustVerifier.LoadAndVerifyAsync(options.TrustFilePath, options.TrustFileSignerPublicKey, ct).ConfigureAwait(false);
        }

        // --- Plugin discovery ---
        if (!Directory.Exists(options.PluginRoot.Value))
        {
            this.logger.LogWarning("Plugin root directory does not exist: {Root}", options.PluginRoot.Value);
            return result.ToImmutable();
        }

        var pluginDirs = Directory.GetDirectories(options.PluginRoot.Value);
        foreach (var dir in pluginDirs)
        {
            ct.ThrowIfCancellationRequested();
            await this.TryLoadPluginAsync(dir, options, trustFile, result, ct).ConfigureAwait(false);
        }

        this.loaded.AddRange(result);
        return result.ToImmutable();
    }

    /// <inheritdoc/>
    public async ValueTask UnloadAsync(LoadedPlugin plugin, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(plugin);
        ObjectDisposedException.ThrowIf(this.disposed, this);

        this.loaded.Remove(plugin);

        if (plugin.Context is not null)
        {
            plugin.Context.Unload();
            this.logger.LogInformation("Unloaded plugin: {Id}", plugin.PluginId);
        }

        await this.bus.PublishAsync(
            new PluginUnloaded
            {
                PluginId = plugin.PluginId,
                AssemblySha256 = this.ComputeAssemblyHash(plugin.AssemblyPath),
                UnloadedAt = this.clock.UtcNow,
            },
            ct).ConfigureAwait(false);

        await this.AppendAuditAsync("PluginUnloaded", $"{{\"pluginId\":\"{plugin.PluginId}\"}}", ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (this.disposed)
        {
            return;
        }

        this.disposed = true;

        foreach (var plugin in this.loaded.ToList())
        {
            plugin.Context?.Unload();
        }

        this.loaded.Clear();
        await ValueTask.CompletedTask.ConfigureAwait(false);
    }

    private async ValueTask TryLoadPluginAsync(
        string dir,
        PluginOptions options,
        TrustFile? trustFile,
        ImmutableArray<LoadedPlugin>.Builder result,
        CancellationToken ct)
    {
        // INV-4: manifest.json must exist.
        var manifestPath = Path.Combine(dir, "manifest.json");
        if (!File.Exists(manifestPath))
        {
            this.logger.LogWarning("Plugin directory missing manifest.json: {Dir}", dir);
            await this.EmitRejectedAsync(Path.GetFileName(dir), string.Empty, "Missing manifest.json (INV-4)", ct).ConfigureAwait(false);
            return;
        }

        PluginManifest? manifest;
        try
        {
            var json = File.ReadAllText(manifestPath);
            manifest = JsonSerializer.Deserialize(json, PluginsJsonContext.Default.PluginManifest);
        }
        catch (Exception ex)
        {
            this.logger.LogWarning(ex, "Failed to parse manifest.json in {Dir}", dir);
            await this.EmitRejectedAsync(Path.GetFileName(dir), string.Empty, $"Malformed manifest.json: {ex.Message}", ct).ConfigureAwait(false);
            return;
        }

        if (manifest is null)
        {
            await this.EmitRejectedAsync(Path.GetFileName(dir), string.Empty, "manifest.json deserialized to null", ct).ConfigureAwait(false);
            return;
        }

        // INV-5: host version compatibility.
        if (!TryParseVersion(manifest.MinHostVersion, out var minHost)
            || !TryParseVersion(manifest.MaxHostVersion, out var maxHost)
            || !TryParseVersion(manifest.PluginVersion, out var pluginVer))
        {
            await this.EmitRejectedAsync(manifest.PluginId, string.Empty, "Invalid version string in manifest", ct).ConfigureAwait(false);
            return;
        }

        var hostVersion = options.HostVersion;
        if (hostVersion < minHost || hostVersion > maxHost)
        {
            this.logger.LogWarning(
                "Plugin {Id} requires host {Min}–{Max} but host is {Host}",
                manifest.PluginId,
                minHost,
                maxHost,
                hostVersion);

            await this.bus.PublishAsync(
                new PluginCompatRejected
                {
                    PluginId = manifest.PluginId,
                    PluginVersion = manifest.PluginVersion,
                    MinHostVersion = manifest.MinHostVersion,
                    MaxHostVersion = manifest.MaxHostVersion,
                    ActualHostVersion = hostVersion.ToString(),
                    RejectedAt = this.clock.UtcNow,
                },
                ct).ConfigureAwait(false);

            await this.EmitRejectedAsync(manifest.PluginId, string.Empty, $"Host version {hostVersion} out of range [{minHost},{maxHost}] (INV-5)", ct).ConfigureAwait(false);
            return;
        }

        // Locate the assembly.
        var assemblyPath = new AbsolutePath(Path.Combine(dir, manifest.AssemblyFileName));
        if (!File.Exists(assemblyPath.Value))
        {
            await this.EmitRejectedAsync(manifest.PluginId, string.Empty, $"Assembly not found: {manifest.AssemblyFileName}", ct).ConfigureAwait(false);
            return;
        }

        // Compute assembly hash.
        var assemblySha256 = this.ComputeAssemblyHash(assemblyPath);

        // Publish discovery event.
        await this.bus.PublishAsync(
            new PluginDiscovered
            {
                PluginId = manifest.PluginId,
                AssemblySha256 = assemblySha256,
                DiscoveredAt = this.clock.UtcNow,
            },
            ct).ConfigureAwait(false);

        // INV-3: trust file check.
        if (options.RequireTrustFile && trustFile is not null)
        {
            var entry = trustFile.TrustedPlugins.FirstOrDefault(tp => tp.PluginId == manifest.PluginId);
            if (entry is null)
            {
                await this.EmitRejectedAsync(manifest.PluginId, assemblySha256, $"Plugin not in trust file (TRUST-ACL-3)", ct).ConfigureAwait(false);
                return;
            }

            if (!string.Equals(entry.AssemblySha256, assemblySha256, StringComparison.OrdinalIgnoreCase))
            {
                await this.EmitRejectedAsync(manifest.PluginId, assemblySha256, $"Assembly SHA-256 mismatch (TRUST-ACL-3). Expected: {entry.AssemblySha256}", ct).ConfigureAwait(false);
                return;
            }

            if (!string.Equals(entry.AuthorPublicKeyFingerprint, manifest.AuthorPublicKeyFingerprint, StringComparison.OrdinalIgnoreCase))
            {
                await this.EmitRejectedAsync(manifest.PluginId, assemblySha256, "Author key fingerprint mismatch (TRUST-ACL-3)", ct).ConfigureAwait(false);
                return;
            }

            if (TryParseVersion(entry.MaxAcceptableVersion, out var maxAccept) && pluginVer > maxAccept)
            {
                await this.EmitRejectedAsync(manifest.PluginId, assemblySha256, $"Plugin version {pluginVer} exceeds trust entry MaxAcceptableVersion {maxAccept}", ct).ConfigureAwait(false);
                return;
            }
        }
        else if (!options.RequireTrustFile)
        {
            // INV-10: emit warning when trust file is not required.
            await this.bus.PublishAsync(
                new PluginUnverifiedLoadAllowed
                {
                    PluginId = manifest.PluginId,
                    LoadedAt = this.clock.UtcNow,
                },
                ct).ConfigureAwait(false);
        }

        // INV-6: load into isolated AssemblyLoadContext.
        var ctx = new PluginLoadContext(assemblyPath, isCollectible: true);
        Assembly assembly;
        try
        {
            assembly = ctx.LoadFromAssemblyPath(assemblyPath.Value);
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Failed to load assembly for plugin {Id}", manifest.PluginId);
            ctx.Unload();
            await this.EmitRejectedAsync(manifest.PluginId, assemblySha256, $"Assembly load failed: {ex.Message}", ct).ConfigureAwait(false);
            return;
        }

        // INV-7: collect capabilities from exported types.
        var exportedTypes = assembly.GetExportedTypes();
        var capabilities = exportedTypes
            .SelectMany(t => t.GetCustomAttributes<PluginCapabilityAttribute>())
            .Select(a => a.Capability)
            .Distinct()
            .ToImmutableArray();

        var loadedPlugin = new LoadedPlugin
        {
            PluginId = manifest.PluginId,
            PluginVersion = pluginVer,
            AssemblyPath = assemblyPath,
            Capabilities = capabilities,
            ExportedTypes = exportedTypes.ToImmutableArray(),
            Context = ctx,
        };

        result.Add(loadedPlugin);

        // INV-9: publish audit events.
        await this.bus.PublishAsync(
            new PluginLoaded
            {
                PluginId = manifest.PluginId,
                AssemblySha256 = assemblySha256,
                Capabilities = capabilities,
                LoadedAt = this.clock.UtcNow,
            },
            ct).ConfigureAwait(false);

        await this.AppendAuditAsync("PluginLoaded", $"{{\"pluginId\":\"{manifest.PluginId}\",\"sha256\":\"{assemblySha256}\"}}", ct).ConfigureAwait(false);

        this.logger.LogInformation("Loaded plugin: {Id} v{Version}", manifest.PluginId, manifest.PluginVersion);
    }

    private async ValueTask EmitRejectedAsync(string pluginId, string sha256, string reason, CancellationToken ct)
    {
        await this.bus.PublishAsync(
            new PluginRejected
            {
                PluginId = pluginId,
                AssemblySha256 = sha256,
                Reason = reason,
                RejectedAt = this.clock.UtcNow,
            },
            ct).ConfigureAwait(false);

        await this.AppendAuditAsync(
            "PluginRejected",
            $"{{\"pluginId\":\"{pluginId}\",\"reason\":\"{reason}\"}}",
            ct).ConfigureAwait(false);
    }

    private async ValueTask AppendAuditAsync(string eventType, string contentJson, CancellationToken ct)
    {
        try
        {
            await this.audit.AppendAsync(
                new AuditRecord
                {
                    EventType = eventType,
                    At = this.clock.UtcNow,
                    Principal = SystemPrincipal,
                    ContentJson = contentJson,
                    ResourceRefs = ImmutableArray<string>.Empty,
                },
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Failed to append audit record for {Event}", eventType);
        }
    }

    private string ComputeAssemblyHash(AbsolutePath assemblyPath)
    {
        try
        {
            var bytes = File.ReadAllBytes(assemblyPath.Value);
            var hash = SHA256.HashData(bytes);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool TryParseVersion(string s, out Version version)
    {
        return Version.TryParse(s, out version!);
    }
}
