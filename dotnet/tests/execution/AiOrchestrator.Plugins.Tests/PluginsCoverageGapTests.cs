// <copyright file="PluginsCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
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
using AiOrchestrator.Plugins.Capability;
using AiOrchestrator.Plugins.Events;
using AiOrchestrator.Plugins.Loading;
using AiOrchestrator.Plugins.Trust;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Plugins.Tests;

/// <summary>Coverage-gap tests for PluginCapabilityAttribute, PluginCapabilityDeniedException,
/// CapabilityChecker, PluginLoader guards, TrustFileVerifier, and PluginLoadContext.</summary>
public sealed class PluginsCoverageGapTests : IDisposable
{
    private readonly string root;

    public PluginsCoverageGapTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "plugin-gap-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); } catch { }
    }

    // ---- PluginCapabilityAttribute -----------------------------------------

    [Fact]
    public void PluginCapabilityAttribute_StoresCapability()
    {
        var attr = new PluginCapabilityAttribute(PluginCapability.ReadFiles);
        Assert.Equal(PluginCapability.ReadFiles, attr.Capability);
    }

    [Theory]
    [InlineData(PluginCapability.ReadFiles)]
    [InlineData(PluginCapability.WriteFiles)]
    [InlineData(PluginCapability.RunProcesses)]
    [InlineData(PluginCapability.NetworkAccess)]
    [InlineData(PluginCapability.ReadAuditLog)]
    [InlineData(PluginCapability.WriteAuditLog)]
    [InlineData(PluginCapability.AccessCredentials)]
    public void PluginCapabilityAttribute_AllCapabilities(PluginCapability cap)
    {
        var attr = new PluginCapabilityAttribute(cap);
        Assert.Equal(cap, attr.Capability);
    }

    // ---- PluginCapability enum ---------------------------------------------

    [Fact]
    public void PluginCapability_AllValuesAreDefined()
    {
        var values = Enum.GetValues<PluginCapability>();
        Assert.Equal(7, values.Length);
    }

    // ---- PluginCapabilityDeniedException -----------------------------------

    [Fact]
    public void PluginCapabilityDeniedException_DefaultCtor()
    {
        var ex = new PluginCapabilityDeniedException
        {
            PluginId = "test",
            Required = PluginCapability.ReadFiles,
        };
        Assert.Equal("test", ex.PluginId);
        Assert.Equal(PluginCapability.ReadFiles, ex.Required);
    }

    [Fact]
    public void PluginCapabilityDeniedException_MessageCtor()
    {
        var ex = new PluginCapabilityDeniedException("denied")
        {
            PluginId = "p1",
            Required = PluginCapability.WriteFiles,
        };
        Assert.Equal("denied", ex.Message);
        Assert.Equal("p1", ex.PluginId);
        Assert.Equal(PluginCapability.WriteFiles, ex.Required);
    }

    [Fact]
    public void PluginCapabilityDeniedException_MessageAndInnerCtor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new PluginCapabilityDeniedException("outer", inner)
        {
            PluginId = "p2",
            Required = PluginCapability.RunProcesses,
        };
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
        Assert.Equal("p2", ex.PluginId);
    }

    // ---- CapabilityChecker -------------------------------------------------

    [Fact]
    public void CapabilityChecker_NullCtor_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new CapabilityChecker(null!));
    }

    [Fact]
    public void CapabilityChecker_IsAllowed_Declared_ReturnsTrue()
    {
        var plugin = MakeLoadedPlugin("p1", PluginCapability.ReadFiles, PluginCapability.WriteFiles);
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["p1"] = ImmutableArray.Create(PluginCapability.ReadFiles, PluginCapability.WriteFiles),
        };
        var checker = new CapabilityChecker(caps);

        Assert.True(checker.IsAllowed(plugin, PluginCapability.ReadFiles));
        Assert.True(checker.IsAllowed(plugin, PluginCapability.WriteFiles));
    }

    [Fact]
    public void CapabilityChecker_IsAllowed_Undeclared_ReturnsFalse()
    {
        var plugin = MakeLoadedPlugin("p1", PluginCapability.ReadFiles);
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["p1"] = ImmutableArray.Create(PluginCapability.ReadFiles),
        };
        var checker = new CapabilityChecker(caps);

        Assert.False(checker.IsAllowed(plugin, PluginCapability.RunProcesses));
    }

    [Fact]
    public void CapabilityChecker_IsAllowed_NullPlugin_Throws()
    {
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>();
        var checker = new CapabilityChecker(caps);
        Assert.Throws<ArgumentNullException>(() => checker.IsAllowed(null!, PluginCapability.ReadFiles));
    }

    [Fact]
    public async Task CapabilityChecker_EnforceAtCallSite_Allowed_DoesNotThrow()
    {
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["p1"] = ImmutableArray.Create(PluginCapability.NetworkAccess),
        };
        var checker = new CapabilityChecker(caps);

        // Should not throw.
        await checker.EnforceAtCallSiteAsync("p1", PluginCapability.NetworkAccess);
    }

    [Fact]
    public void CapabilityChecker_EnforceAtCallSite_Denied_Throws()
    {
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["p1"] = ImmutableArray.Create(PluginCapability.ReadFiles),
        };
        var checker = new CapabilityChecker(caps);

        var ex = Assert.Throws<PluginCapabilityDeniedException>(() =>
            checker.EnforceAtCallSiteAsync("p1", PluginCapability.RunProcesses).GetAwaiter().GetResult());

        Assert.Equal("p1", ex.PluginId);
        Assert.Equal(PluginCapability.RunProcesses, ex.Required);
    }

    [Fact]
    public void CapabilityChecker_EnforceAtCallSite_UnknownPlugin_Throws()
    {
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>();
        var checker = new CapabilityChecker(caps);

        var ex = Assert.Throws<PluginCapabilityDeniedException>(() =>
            checker.EnforceAtCallSiteAsync("unknown-plugin", PluginCapability.ReadFiles).GetAwaiter().GetResult());

        Assert.Equal("unknown-plugin", ex.PluginId);
    }

    [Fact]
    public void CapabilityChecker_EnforceAtCallSite_NullPluginId_Throws()
    {
        var caps = new Dictionary<string, ImmutableArray<PluginCapability>>();
        var checker = new CapabilityChecker(caps);

        Assert.Throws<ArgumentNullException>(() =>
            checker.EnforceAtCallSiteAsync(null!, PluginCapability.ReadFiles).GetAwaiter().GetResult());
    }

    // ---- PluginLoader constructor null-guards ------------------------------

    [Fact]
    public void PluginLoader_NullFs_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(null!, new StaticClock(DateTimeOffset.UtcNow), new CollectingEventBus([]),
                new NullAuditLog(), MakeOpts(), NullLogger<PluginLoader>.Instance));
    }

    [Fact]
    public void PluginLoader_NullClock_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(new PassthroughFileSystem(), null!, new CollectingEventBus([]),
                new NullAuditLog(), MakeOpts(), NullLogger<PluginLoader>.Instance));
    }

    [Fact]
    public void PluginLoader_NullBus_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(new PassthroughFileSystem(), new StaticClock(DateTimeOffset.UtcNow), null!,
                new NullAuditLog(), MakeOpts(), NullLogger<PluginLoader>.Instance));
    }

    [Fact]
    public void PluginLoader_NullAudit_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(new PassthroughFileSystem(), new StaticClock(DateTimeOffset.UtcNow), new CollectingEventBus([]),
                null!, MakeOpts(), NullLogger<PluginLoader>.Instance));
    }

    [Fact]
    public void PluginLoader_NullOpts_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(new PassthroughFileSystem(), new StaticClock(DateTimeOffset.UtcNow), new CollectingEventBus([]),
                new NullAuditLog(), null!, NullLogger<PluginLoader>.Instance));
    }

    [Fact]
    public void PluginLoader_NullLogger_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new PluginLoader(new PassthroughFileSystem(), new StaticClock(DateTimeOffset.UtcNow), new CollectingEventBus([]),
                new NullAuditLog(), MakeOpts(), null!));
    }

    // ---- PluginLoader DisposeAsync idempotent ------------------------------

    [Fact]
    public async Task PluginLoader_DoubleDispose_IsSafe()
    {
        var loader = BuildLoader(this.root, requireTrust: false);
        await loader.DisposeAsync();
        await loader.DisposeAsync(); // should not throw
    }

    // ---- PluginLoader ObjectDisposedException after dispose -----------------

    [Fact]
    public async Task PluginLoader_DiscoverAndLoadAsync_AfterDispose_Throws()
    {
        var loader = BuildLoader(this.root, requireTrust: false);
        await loader.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await loader.DiscoverAndLoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task PluginLoader_UnloadAsync_AfterDispose_Throws()
    {
        var loader = BuildLoader(this.root, requireTrust: false);
        await loader.DisposeAsync();

        var fakePlugin = MakeLoadedPlugin("p1");
        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await loader.UnloadAsync(fakePlugin, CancellationToken.None));
    }

    // ---- PluginLoader UnloadAsync null-guard -------------------------------

    [Fact]
    public async Task PluginLoader_UnloadAsync_NullPlugin_Throws()
    {
        await using var loader = BuildLoader(this.root, requireTrust: false);
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await loader.UnloadAsync(null!, CancellationToken.None));
    }

    // ---- PluginLoader Loaded property starts empty -------------------------

    [Fact]
    public void PluginLoader_Loaded_StartsEmpty()
    {
        var loader = BuildLoader(this.root, requireTrust: false);
        Assert.Empty(loader.Loaded);
    }

    // ---- PluginLoader: missing plugin root ---------------------------------

    [Fact]
    public async Task PluginLoader_MissingPluginRoot_ReturnsEmpty()
    {
        var nonexistent = Path.Combine(this.root, "does-not-exist-" + Guid.NewGuid().ToString("N"));
        await using var loader = BuildLoader(nonexistent, requireTrust: false);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
    }

    // ---- PluginLoader: trust file required but key empty -------------------

    [Fact]
    public async Task PluginLoader_RequireTrustFile_EmptyKey_Throws()
    {
        var trustPath = Path.Combine(this.root, "empty-key-trust.json");
        File.WriteAllText(trustPath, "{}");
        SetOwnerOnlyPerms(trustPath);

        var loader = BuildLoaderWithTrust(this.root, trustPath, pubKey: [], requireTrust: true);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await loader.DiscoverAndLoadAsync(CancellationToken.None));
    }

    // ---- PluginLoader: malformed manifest ----------------------------------

    [Fact]
    public async Task PluginLoader_MalformedManifest_PluginRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "bad-manifest")).FullName;
        File.WriteAllText(Path.Combine(pluginDir, "manifest.json"), "{{not valid json");

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, requireTrust: false, events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("manifest", StringComparison.OrdinalIgnoreCase));
    }

    // ---- PluginLoader: manifest null deserialization -----------------------

    [Fact]
    public async Task PluginLoader_NullManifest_PluginRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "null-manifest")).FullName;
        File.WriteAllText(Path.Combine(pluginDir, "manifest.json"), "null");

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, requireTrust: false, events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("null", StringComparison.OrdinalIgnoreCase));
    }

    // ---- PluginLoader: invalid version strings in manifest -----------------

    [Fact]
    public async Task PluginLoader_InvalidVersionString_PluginRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "bad-version")).FullName;
        WriteManifest(pluginDir, "bad-ver-plugin", pluginVer: "not.a.version");

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, requireTrust: false, events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("version", StringComparison.OrdinalIgnoreCase));
    }

    // ---- PluginLoader: assembly not found ----------------------------------

    [Fact]
    public async Task PluginLoader_AssemblyNotFound_PluginRejected()
    {
        var pluginDir = Directory.CreateDirectory(Path.Combine(this.root, "no-assembly")).FullName;
        WriteManifest(pluginDir, "no-asm", assemblyFileName: "nonexistent.dll");

        var events = new List<object>();
        await using var loader = BuildLoader(this.root, requireTrust: false, events: events);

        var result = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        Assert.Empty(result);
        Assert.Contains(events, e => e is PluginRejected r && r.Reason.Contains("Assembly not found", StringComparison.OrdinalIgnoreCase));
    }

    // ---- TrustFileVerifier: nonexistent file returns false -----------------

    [Fact]
    public async Task TrustFileVerifier_NonexistentFile_ReturnsFalse()
    {
        var fs = new PassthroughFileSystem();
        var verifier = new TrustFileVerifier(fs);
        var nonexistent = new AbsolutePath(Path.Combine(this.root, "does-not-exist.json"));

        var valid = await verifier.IsTrustFileValidAsync(nonexistent, CancellationToken.None);

        Assert.False(valid);
    }

    // ---- TrustFileVerifier: malformed JSON throws --------------------------

    [Fact]
    public async Task TrustFileVerifier_MalformedJson_Throws()
    {
        var fs = new PassthroughFileSystem();
        var verifier = new TrustFileVerifier(fs);
        var trustPath = Path.Combine(this.root, "malformed.json");
        File.WriteAllText(trustPath, "{{not json");

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await verifier.LoadAndVerifyAsync(new AbsolutePath(trustPath), new byte[32], CancellationToken.None));
    }

    // ---- TrustFileVerifier: null deserialization throws ---------------------

    [Fact]
    public async Task TrustFileVerifier_NullDeserialization_Throws()
    {
        var fs = new PassthroughFileSystem();
        var verifier = new TrustFileVerifier(fs);
        var trustPath = Path.Combine(this.root, "null-trust.json");
        File.WriteAllText(trustPath, "null");

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await verifier.LoadAndVerifyAsync(new AbsolutePath(trustPath), new byte[32], CancellationToken.None));
    }

    // ---- TrustFileVerifier: null pubkey throws -----------------------------

    [Fact]
    public async Task TrustFileVerifier_NullPubKey_Throws()
    {
        var fs = new PassthroughFileSystem();
        var verifier = new TrustFileVerifier(fs);

        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await verifier.LoadAndVerifyAsync(new AbsolutePath("/fake"), null!, CancellationToken.None));
    }

    // ---- TrustFileVerifier constructor null-guard ---------------------------

    [Fact]
    public void TrustFileVerifier_NullFs_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new TrustFileVerifier(null!));
    }

    // ---- PluginLoadContext: basic construction ------------------------------

    [Fact]
    public void PluginLoadContext_CanConstruct()
    {
        var path = new AbsolutePath(Path.Combine(this.root, "test-plugin.dll"));
        var context = new PluginLoadContext(path, isCollectible: true);

        Assert.NotNull(context);
        Assert.Contains("plugin:", context.Name);
        context.Unload();
    }

    [Fact]
    public void PluginLoadContext_NonCollectible_CanConstruct()
    {
        var path = new AbsolutePath(Path.Combine(this.root, "test-plugin.dll"));
        var context = new PluginLoadContext(path, isCollectible: false);

        Assert.NotNull(context);
        Assert.Contains("plugin:", context.Name);
        // Non-collectible contexts cannot be unloaded — just verify construction.
    }

    [Fact]
    public void PluginLoadContext_NullDirectoryPath_Throws()
    {
        // A path that has no directory component is invalid.
        Assert.Throws<ArgumentException>(() =>
            new PluginLoadContext(new AbsolutePath("justfilename.dll"), isCollectible: false));
    }

    // ---- PluginManifest construction ---------------------------------------

    [Fact]
    public void PluginManifest_AllPropertiesCanBeSet()
    {
        var manifest = new PluginManifest
        {
            PluginId = "test-id",
            PluginVersion = "1.2.3",
            MinHostVersion = "0.0.0.0",
            MaxHostVersion = "99.99.99.99",
            AssemblyFileName = "test.dll",
            AuthorPublicKeyFingerprint = "aabbcc",
            Capabilities = ImmutableArray.Create("ReadFiles"),
        };

        Assert.Equal("test-id", manifest.PluginId);
        Assert.Equal("1.2.3", manifest.PluginVersion);
        Assert.Single(manifest.Capabilities);
    }

    // ---- PluginOptions construction ----------------------------------------

    [Fact]
    public void PluginOptions_Defaults()
    {
        var opts = new PluginOptions
        {
            PluginRoot = new AbsolutePath("/plugins"),
            TrustFilePath = new AbsolutePath("/trust.json"),
        };

        Assert.True(opts.RequireTrustFile);
        Assert.NotNull(opts.HostVersion);
        Assert.Empty(opts.TrustFileSignerPublicKey);
    }

    // ---- LoadedPlugin construction -----------------------------------------

    [Fact]
    public void LoadedPlugin_CanConstruct()
    {
        var plugin = new LoadedPlugin
        {
            PluginId = "p1",
            PluginVersion = new Version(1, 0),
            AssemblyPath = new AbsolutePath("/p1/plugin.dll"),
            Capabilities = ImmutableArray.Create(PluginCapability.ReadFiles),
            ExportedTypes = ImmutableArray<Type>.Empty,
        };

        Assert.Equal("p1", plugin.PluginId);
        Assert.Equal(new Version(1, 0), plugin.PluginVersion);
        Assert.Single(plugin.Capabilities);
        Assert.Null(plugin.Context);
    }

    // ---- Helpers -----------------------------------------------------------

    private static LoadedPlugin MakeLoadedPlugin(string id, params PluginCapability[] capabilities)
    {
        return new LoadedPlugin
        {
            PluginId = id,
            PluginVersion = new Version(1, 0),
            AssemblyPath = new AbsolutePath("/fake/plugin.dll"),
            Capabilities = ImmutableArray.Create(capabilities),
            ExportedTypes = ImmutableArray<Type>.Empty,
        };
    }

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

    private static IOptionsMonitor<PluginOptions> MakeOpts()
    {
        return new StaticOptionsMonitor<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath("/fake"),
            TrustFilePath = new AbsolutePath("/fake-trust"),
        });
    }

    private PluginLoader BuildLoader(string pluginRoot, bool requireTrust, List<object>? events = null)
    {
        var bus = new CollectingEventBus(events ?? []);
        var audit = new NullAuditLog();
        var clock = new StaticClock(DateTimeOffset.UtcNow);
        var fs = new PassthroughFileSystem();
        var opts = new StaticOptionsMonitor<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath(pluginRoot),
            TrustFilePath = new AbsolutePath(Path.Combine(this.root, "trust.json")),
            RequireTrustFile = requireTrust,
            TrustFileSignerPublicKey = [],
            HostVersion = new Version(1, 0, 0, 0),
        });
        return new PluginLoader(fs, clock, bus, audit, opts, NullLogger<PluginLoader>.Instance);
    }

    private PluginLoader BuildLoaderWithTrust(string pluginRoot, string trustPath, byte[] pubKey, bool requireTrust)
    {
        var bus = new CollectingEventBus([]);
        var audit = new NullAuditLog();
        var clock = new StaticClock(DateTimeOffset.UtcNow);
        var fs = new PassthroughFileSystem();
        var opts = new StaticOptionsMonitor<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath(pluginRoot),
            TrustFilePath = new AbsolutePath(trustPath),
            RequireTrustFile = requireTrust,
            TrustFileSignerPublicKey = pubKey,
            HostVersion = new Version(1, 0, 0, 0),
        });
        return new PluginLoader(fs, clock, bus, audit, opts, NullLogger<PluginLoader>.Instance);
    }

    private static void SetOwnerOnlyPerms(string path)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var fileInfo = new FileInfo(path);
            var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User;
            if (owner is null) { return; }

            var security = fileInfo.GetAccessControl();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

            var existing = security.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier));
            foreach (System.Security.AccessControl.FileSystemAccessRule rule in existing)
            {
                security.RemoveAccessRule(rule);
            }

            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                owner,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.None,
                System.Security.AccessControl.PropagationFlags.None,
                System.Security.AccessControl.AccessControlType.Allow));

            fileInfo.SetAccessControl(security);
        }
        else
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
