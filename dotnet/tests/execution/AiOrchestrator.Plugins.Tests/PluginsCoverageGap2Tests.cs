// <copyright file="PluginsCoverageGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plugins.Events;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Plugins.Tests;

/// <summary>Targeted coverage-gap tests for Plugins assembly (~5 lines).</summary>
public sealed class PluginsCoverageGap2Tests : IDisposable
{
    private readonly string root;

    public PluginsCoverageGap2Tests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "plugin-gap2-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); } catch { }
    }

    // ================================================================
    // PluginLoader — host version out of range (INV-5)
    // ================================================================

    [Fact]
    public async Task PluginLoader_HostVersionOutOfRange_EmitsCompatRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "compat-reject")).FullName;
        WriteManifest(pluginDir, "compat-plugin", minHost: "5.0.0.0", maxHost: "6.0.0.0");

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, hostVersion: new Version(1, 0, 0, 0), events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginCompatRejected);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("INV-5", StringComparison.Ordinal));
    }

    // ================================================================
    // PluginLoader — no manifest.json in plugin dir (INV-4)
    // ================================================================

    [Fact]
    public async Task PluginLoader_MissingManifestJson_EmitsRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "no-manifest")).FullName;
        // Don't write manifest.json

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("manifest.json", StringComparison.OrdinalIgnoreCase));
    }

    // ================================================================
    // PluginLoader — unverified load warning (INV-10)
    // ================================================================

    [Fact]
    public async Task PluginLoader_NoTrustFile_EmitsUnverifiedLoadWarning()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "unverified-plugin")).FullName;
        WriteManifest(pluginDir, "unverified", assemblyFileName: "plugin.dll");
        // Create a dummy assembly
        File.WriteAllBytes(Path.Combine(pluginDir, "plugin.dll"), new byte[] { 0 });

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, events: events);

        // Will fail to load the assembly (not valid PE) but should emit unverified-load warning before that
        _ = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Contains(events, e => e is PluginUnverifiedLoadAllowed);
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static void WriteManifest(string dir, string id, string pluginVer = "1.0.0",
        string minHost = "0.0.0.0", string maxHost = "99.99.99.99",
        string assemblyFileName = "plugin.dll", string keyFingerprint = "aabbcc")
    {
        var manifest = new
        {
            pluginId = id,
            pluginVersion = pluginVer,
            minHostVersion = minHost,
            maxHostVersion = maxHost,
            capabilities = Array.Empty<string>(),
            assemblyFileName,
            authorPublicKeyFingerprint = keyFingerprint,
        };
        File.WriteAllText(Path.Combine(dir, "manifest.json"), JsonSerializer.Serialize(manifest));
    }

    private PluginLoader BuildLoader(string pluginRoot, Version? hostVersion = null, List<object>? events = null)
    {
        var bus = new CollectingBus(events ?? []);
        var audit = new NullAudit();
        var clock = new StaticClock2(DateTimeOffset.UtcNow);
        var fs = new PassthroughFs();
        var opts = new StaticOpts<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath(pluginRoot),
            TrustFilePath = new AbsolutePath(Path.Combine(this.root, "trust.json")),
            RequireTrustFile = false,
            TrustFileSignerPublicKey = [],
            HostVersion = hostVersion ?? new Version(1, 0, 0, 0),
        });
        return new PluginLoader(fs, clock, bus, audit, opts, NullLogger<PluginLoader>.Instance);
    }

    private sealed class CollectingBus(List<object> events) : IEventBus
    {
        public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct) where TEvent : notnull
        {
            lock (events) { events.Add(@event); }
            return ValueTask.CompletedTask;
        }

        public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
            where TEvent : notnull => new NullSub();

        private sealed class NullSub : IAsyncDisposable { public ValueTask DisposeAsync() => ValueTask.CompletedTask; }
    }

    private sealed class NullAudit : IAuditLog
    {
        public ValueTask AppendAsync(AuditRecord record, CancellationToken ct) => ValueTask.CompletedTask;
        public IAsyncEnumerable<AuditRecord> ReadAsync(CancellationToken ct) => throw new NotSupportedException();
        public ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct) =>
            ValueTask.FromResult(new ChainVerification { Ok = true });
    }

    private sealed class StaticClock2(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow => now;
        public long MonotonicMilliseconds => 0;
    }

    private sealed class PassthroughFs : IFileSystem
    {
        public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(File.Exists(path.Value) || Directory.Exists(path.Value));
        public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(File.ReadAllText(path.Value));
        public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) { File.WriteAllText(path.Value, contents); return default; }
        public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => new(File.OpenRead(path.Value));
        public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => throw new NotSupportedException();
        public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => default;
        public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;
        public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
    }

    private sealed class StaticOpts<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;
        public T Get(string? name) => value;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
