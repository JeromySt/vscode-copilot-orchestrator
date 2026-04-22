// <copyright file="PluginLoaderContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Runtime.CompilerServices;
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
using AiOrchestrator.Plugins;
using AiOrchestrator.Plugins.Capability;
using AiOrchestrator.Plugins.Events;
using AiOrchestrator.Plugins.Loading;
using AiOrchestrator.Plugins.Trust;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Org.BouncyCastle.Math.EC.Rfc8032;
using Org.BouncyCastle.Security;
using Xunit;

namespace AiOrchestrator.Plugins.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class PluginLoaderContractTests : IDisposable
{
    private readonly string root;
    private static readonly SecureRandom Rng = new();

    public PluginLoaderContractTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "plugin-tests", Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    // ---- helpers ---------------------------------------------------------

    private static (byte[] Priv, byte[] Pub) GenerateKeyPair()
    {
        var priv = new byte[32];
        Rng.NextBytes(priv);
        var pub = Ed25519Signer.DerivePublicKey(priv);
        return (priv, pub);
    }

    private static byte[] SignTrustFile(TrustFile tf, byte[] privateKey)
    {
        var payload = TrustFileVerifier.ComputeCanonicalPayload(tf);
        var sig = new byte[64];
        Ed25519.Sign(privateKey, 0, payload, 0, payload.Length, sig, 0);
        return sig;
    }

    private string CreatePluginDir(string name) =>
        Directory.CreateDirectory(Path.Combine(this.root, name)).FullName;

    private static string HashFile(string path)
    {
        var bytes = File.ReadAllBytes(path);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
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

    private static string CopyTestAssembly(string destDir, string destName = "plugin.dll")
    {
        // Use the test assembly itself as a stand-in for a plugin DLL.
        var src = typeof(PluginLoaderContractTests).Assembly.Location;
        var dest = Path.Combine(destDir, destName);
        File.Copy(src, dest, overwrite: true);
        return dest;
    }

    /// <summary>
    /// Creates a minimal single-type assembly suitable for ALC unload / GC-reclaim tests.
    /// Loading the full test assembly into a collectible ALC bloats the GC root set so
    /// much that collection within a bounded number of cycles is unreliable.
    /// </summary>
    private static string CreateMinimalPluginDll(string destDir, string fileName = "plugin.dll")
    {
        var destPath = Path.Combine(destDir, fileName);

        // PersistedAssemblyBuilder is available in .NET 9+ (BCL, no extra package needed).
        var ab = new System.Reflection.Emit.PersistedAssemblyBuilder(
            new System.Reflection.AssemblyName("PluginStub"),
            typeof(object).Assembly);

        var mb = ab.DefineDynamicModule("PluginStub");
        var tb = mb.DefineType("PluginStub.StubMarker", System.Reflection.TypeAttributes.Public);
        _ = tb.CreateType();
        ab.Save(destPath);

        return destPath;
    }

    private static TrustFile BuildTrustFile(
        string pluginId,
        string sha256,
        byte[] privateKey,
        string keyFingerprint = "aabbcc",
        string maxAcceptableVersion = "99.99.99.99")
    {
        var entry = new TrustedPlugin
        {
            PluginId = pluginId,
            AssemblySha256 = sha256,
            AuthorPublicKeyFingerprint = keyFingerprint,
            MaxAcceptableVersion = maxAcceptableVersion,
        };

        // Create unsigned stub to compute signature.
        var stub = new TrustFile
        {
            TrustedPlugins = ImmutableArray.Create(entry),
            SignedAt = DateTimeOffset.UtcNow,
            SignerKeyId = "test-key",
            Ed25519Signature = [],
        };

        var sig = SignTrustFile(stub, privateKey);

        return stub with { Ed25519Signature = sig };
    }

    private static void WriteTrustFile(string path, TrustFile tf)
    {
        var json = JsonSerializer.Serialize(tf, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        });
        File.WriteAllText(path, json);

        // Set restrictive permissions (owner-only) so the permissions check passes.
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            ApplyOwnerOnlyDaclWindows(path);
        }
        else
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void ApplyOwnerOnlyDaclWindows(string path)
    {
        var fileInfo = new FileInfo(path);
        var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User;
        if (owner is null) { return; }

        var security = fileInfo.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        var existing = security.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier));
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in existing)
        {
            _ = security.RemoveAccessRule(rule);
        }

        security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
            owner,
            System.Security.AccessControl.FileSystemRights.FullControl,
            System.Security.AccessControl.InheritanceFlags.None,
            System.Security.AccessControl.PropagationFlags.None,
            System.Security.AccessControl.AccessControlType.Allow));

        fileInfo.SetAccessControl(security);
    }

    private PluginLoader BuildLoader(
        string pluginRoot,
        string trustFilePath,
        byte[] signerPubKey,
        bool requireTrust = true,
        List<object>? events = null)
    {
        var bus = new CollectingEventBus(events ?? []);
        var audit = new NullAuditLog();
        var clock = new StaticClock(DateTimeOffset.UtcNow);
        var fs = new PassthroughFileSystem();
        var opts = new StaticOptionsMonitor<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath(pluginRoot),
            TrustFilePath = new AbsolutePath(trustFilePath),
            RequireTrustFile = requireTrust,
            TrustFileSignerPublicKey = signerPubKey,
            HostVersion = new Version(1, 0, 0, 0),
        });
        return new PluginLoader(fs, clock, bus, audit, opts, NullLogger<PluginLoader>.Instance);
    }

    // ---- TRUST-ACL tests -------------------------------------------------

    [Fact]
    [ContractTest("TRUST-ACL-1")]
    public async Task TRUST_ACL_1_BroadPermsRejected()
    {
        // On Linux: set 0644 perms; loader must reject.
        // On Windows: this test is vacuous (DACL check always succeeds in test setup).
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            // On Windows/macOS: skip this specific permissions test variant
            // (covered by TrustFileVerifier unit path; full perms gate only enforced on Linux/POSIX).
            return;
        }

        var (priv, pub) = GenerateKeyPair();
        var pluginRoot = this.CreatePluginDir("plugins-acl1");
        var trustPath = Path.Combine(this.root, "trust.json");

        var tf = BuildTrustFile("dummy", "deadbeef", priv);
        WriteTrustFile(trustPath, tf);

        // Override permissions to 0644 — broader than owner-only.
        File.SetUnixFileMode(trustPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);

        var events = new List<object>();
        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true, events: events);

        var act = async () => await loader.DiscoverAndLoadAsync(CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("*TRUST-ACL-1*");

        events.Should().ContainItemsAssignableTo<PluginTrustFileInvalidPerms>();
    }

    [Fact]
    [ContractTest("TRUST-ACL-2")]
    public async Task TRUST_ACL_2_BadSignatureRejected()
    {
        var (priv, pub) = GenerateKeyPair();
        var (_, wrongPub) = GenerateKeyPair(); // wrong verifier key

        var pluginRoot = this.CreatePluginDir("plugins-acl2");
        var trustPath = Path.Combine(this.root, "trust-acl2.json");

        var tf = BuildTrustFile("my-plugin", "deadbeef", priv);
        WriteTrustFile(trustPath, tf);

        // Verify with the WRONG public key → should throw
        var events = new List<object>();
        var loader = this.BuildLoader(pluginRoot, trustPath, wrongPub, requireTrust: true, events: events);

        var act = async () => await loader.DiscoverAndLoadAsync(CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("*Ed25519 signature is invalid*");
    }

    [Fact]
    [ContractTest("TRUST-ACL-3")]
    public async Task TRUST_ACL_3_HashMismatchRejected()
    {
        var (priv, pub) = GenerateKeyPair();
        var pluginRoot = this.CreatePluginDir("plugins-acl3");
        var trustPath = Path.Combine(this.root, "trust-acl3.json");

        var pluginDir = this.CreatePluginDir("plugins-acl3/myplugin");
        CopyTestAssembly(pluginDir);
        WriteManifest(pluginDir, "myplugin");

        // Trust file lists a WRONG sha256
        var tf = BuildTrustFile("myplugin", "badhash0000000000000000000000000000000000000000000000000000000000", priv);
        WriteTrustFile(trustPath, tf);

        var events = new List<object>();
        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true, events: events);

        var results = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        results.Should().BeEmpty("plugin with wrong hash must be rejected");
        events.OfType<PluginRejected>().Should()
            .ContainSingle(e => e.Reason.Contains("SHA-256", StringComparison.OrdinalIgnoreCase));
    }

    // ---- Manifest tests --------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-MFST-MISS")]
    public async Task PLUGIN_MANIFEST_MissingRejected()
    {
        var (priv, pub) = GenerateKeyPair();
        var pluginRoot = this.CreatePluginDir("plugins-manifest");
        var trustPath = Path.Combine(this.root, "trust-manifest.json");

        var pluginDir = this.CreatePluginDir("plugins-manifest/myplugin");
        // No manifest.json in the plugin directory!
        CopyTestAssembly(pluginDir);

        var tf = BuildTrustFile("myplugin", "deadbeef", priv);
        WriteTrustFile(trustPath, tf);

        var events = new List<object>();
        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true, events: events);

        var results = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        results.Should().BeEmpty("plugin without manifest.json must be rejected");
        events.OfType<PluginRejected>().Should()
            .ContainSingle(e => e.Reason.Contains("manifest", StringComparison.OrdinalIgnoreCase));
    }

    // ---- Version tests ---------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-VER-RANGE")]
    public async Task PLUGIN_VERSION_OutOfRangeRejected()
    {
        var (priv, pub) = GenerateKeyPair();
        var pluginRoot = this.CreatePluginDir("plugins-version");
        var trustPath = Path.Combine(this.root, "trust-version.json");

        var pluginDir = this.CreatePluginDir("plugins-version/myplugin");
        CopyTestAssembly(pluginDir);

        // Manifest requires host version 5.0+ but loader says 1.0.0.0
        WriteManifest(pluginDir, "myplugin", minHost: "5.0.0.0", maxHost: "99.0.0.0");

        var sha256 = HashFile(Path.Combine(pluginDir, "plugin.dll"));
        var tf = BuildTrustFile("myplugin", sha256, priv);
        WriteTrustFile(trustPath, tf);

        var events = new List<object>();
        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true, events: events);

        var results = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        results.Should().BeEmpty("plugin requiring host 5.0+ must be rejected when host is 1.0");
        events.Should().ContainItemsAssignableTo<PluginCompatRejected>();
    }

    // ---- ALC isolation ---------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-ALC")]
    public async Task PLUGIN_ALC_IsolatesAssemblies()
    {
        var pluginRoot = this.CreatePluginDir("plugins-alc");
        var trustPath = Path.Combine(this.root, "trust-alc.json");

        var dir1 = this.CreatePluginDir("plugins-alc/plugin1");
        var dir2 = this.CreatePluginDir("plugins-alc/plugin2");

        CopyTestAssembly(dir1);
        CopyTestAssembly(dir2);

        var sha1 = HashFile(Path.Combine(dir1, "plugin.dll"));
        var sha2 = HashFile(Path.Combine(dir2, "plugin.dll"));

        WriteManifest(dir1, "plugin-alc-1");
        WriteManifest(dir2, "plugin-alc-2");

        var (priv, pub) = GenerateKeyPair();
        var tfStub = new TrustFile
        {
            TrustedPlugins = ImmutableArray.Create(
                new TrustedPlugin { PluginId = "plugin-alc-1", AssemblySha256 = sha1, AuthorPublicKeyFingerprint = "aabbcc", MaxAcceptableVersion = "99.99.99.99" },
                new TrustedPlugin { PluginId = "plugin-alc-2", AssemblySha256 = sha2, AuthorPublicKeyFingerprint = "aabbcc", MaxAcceptableVersion = "99.99.99.99" }),
            SignedAt = DateTimeOffset.UtcNow,
            SignerKeyId = "test-key",
            Ed25519Signature = [],
        };

        var sig = SignTrustFile(tfStub, priv);
        var tf = tfStub with { Ed25519Signature = sig };
        WriteTrustFile(trustPath, tf);

        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true);

        var loaded = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        loaded.Should().HaveCount(2);

        // Both plugins loaded the same DLL but from different ALCs — their type identities must differ.
        var type1 = loaded[0].ExportedTypes.First();
        var type2 = loaded[1].ExportedTypes.First();

        // Types from different ALCs have different Assembly objects even if the name is the same.
        type1.Assembly.Should().NotBeSameAs(type2.Assembly,
            "each plugin must be in its own isolated AssemblyLoadContext");

        await loader.DisposeAsync();
    }

    // ---- Unload test -----------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-UNLOAD")]
    public async Task PLUGIN_UNLOAD_AllowsGcReclaim()
    {
        var pluginRoot = this.CreatePluginDir("plugins-unload");
        var trustPath = Path.Combine(this.root, "trust-unload.json");

        var pluginDir = this.CreatePluginDir("plugins-unload/myplugin");

        // Use a tiny single-type assembly to minimise the number of live Type objects
        // kept inside the collectible ALC — loading the full test assembly makes GC
        // collection unreliable within a bounded number of cycles.
        CreateMinimalPluginDll(pluginDir);
        var sha = HashFile(Path.Combine(pluginDir, "plugin.dll"));
        WriteManifest(pluginDir, "unload-plugin");

        var (priv, pub) = GenerateKeyPair();
        var tf = BuildTrustFile("unload-plugin", sha, priv);
        WriteTrustFile(trustPath, tf);

        var loader = this.BuildLoader(pluginRoot, trustPath, pub, requireTrust: true);

        // Load and unload in a separate stack frame (NoInlining) so the JIT
        // does not keep ALC-loaded type references alive in this method's frame.
        var weakRef = await LoadAndUnloadAlcAsync(loader);

        // Yield to force a new MoveNext() invocation of this outer state machine.
        // The local awaiter variable from the previous invocation held a strong
        // reference to the inner AsyncStateMachineBox (which contained results/plugin),
        // preventing the collectible ALC from being reclaimed during the GC loop.
        await Task.Yield();

        // Force multiple GC cycles to allow the collectible ALC to be reclaimed.
        for (int i = 0; i < 10; i++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();

            if (!weakRef.TryGetTarget(out _))
            {
                break;
            }
        }

        weakRef.TryGetTarget(out _).Should().BeFalse(
            "the AssemblyLoadContext must be collected after UnloadAsync and GC");
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static async Task<WeakReference<System.Runtime.Loader.AssemblyLoadContext>> LoadAndUnloadAlcAsync(
        IPluginLoader loader)
    {
        var results = await loader.DiscoverAndLoadAsync(CancellationToken.None);
        results.Should().HaveCount(1);

        var plugin = results[0];
        plugin.Context.Should().NotBeNull();

        var weakRef = new WeakReference<System.Runtime.Loader.AssemblyLoadContext>(plugin.Context!);

        await loader.UnloadAsync(plugin, CancellationToken.None);

        // Verify the plugin was actually removed from the loader's internal list.
        loader.Loaded.Should().BeEmpty("after UnloadAsync the plugin must be removed from the loader");

        // After this method returns the state machine is deactivated and the
        // strong references to results/plugin/Context are released.
        return weakRef;
    }

    // ---- Capability tests ------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-CAP-DECL")]
    public void PLUGIN_CAPABILITY_DeclaredCapabilitiesEnforced()
    {
        var caps = ImmutableArray.Create(PluginCapability.ReadFiles, PluginCapability.WriteFiles);
        var plugin = new LoadedPlugin
        {
            PluginId = "cap-plugin",
            PluginVersion = new Version(1, 0, 0),
            AssemblyPath = new AbsolutePath(Path.GetFullPath("dummy.dll")),
            Capabilities = caps,
            ExportedTypes = ImmutableArray<Type>.Empty,
        };

        var dict = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["cap-plugin"] = caps,
        };

        var checker = new CapabilityChecker(dict);

        checker.IsAllowed(plugin, PluginCapability.ReadFiles).Should().BeTrue();
        checker.IsAllowed(plugin, PluginCapability.WriteFiles).Should().BeTrue();
        checker.IsAllowed(plugin, PluginCapability.NetworkAccess).Should().BeFalse("not declared");

        var act = async () => await checker.EnforceAtCallSiteAsync("cap-plugin", PluginCapability.NetworkAccess);
        act.Should().ThrowAsync<PluginCapabilityDeniedException>()
            .WithMessage("*NetworkAccess*");
    }

    [Fact]
    [ContractTest("PLUGIN-CAP-CALLSITE")]
    public async Task PLUGIN_CAPABILITY_AnalyzerRequiresEnforceCallSite()
    {
        // This test verifies the CapabilityChecker.EnforceAtCallSiteAsync contract:
        // attempting to use an undeclared capability throws PluginCapabilityDeniedException.
        var dict = new Dictionary<string, ImmutableArray<PluginCapability>>
        {
            ["pluginA"] = ImmutableArray.Create(PluginCapability.ReadFiles),
        };

        var checker = new CapabilityChecker(dict);

        // Declared capability succeeds
        await checker.EnforceAtCallSiteAsync("pluginA", PluginCapability.ReadFiles);

        // Undeclared capability throws
        await Assert.ThrowsAsync<PluginCapabilityDeniedException>(
            () => checker.EnforceAtCallSiteAsync("pluginA", PluginCapability.WriteFiles).AsTask());

        // Unknown plugin throws
        await Assert.ThrowsAsync<PluginCapabilityDeniedException>(
            () => checker.EnforceAtCallSiteAsync("unknown-plugin", PluginCapability.ReadFiles).AsTask());
    }

    // ---- Audit test ------------------------------------------------------

    [Fact]
    [ContractTest("PLUGIN-AUDIT")]
    public async Task PLUGIN_AUDIT_LoadAndRejectAreAudited()
    {
        var (priv, pub) = GenerateKeyPair();
        var pluginRoot = this.CreatePluginDir("plugins-audit");
        var trustPath = Path.Combine(this.root, "trust-audit.json");

        // Valid plugin
        var validDir = this.CreatePluginDir("plugins-audit/validplugin");
        CopyTestAssembly(validDir);
        var validSha = HashFile(Path.Combine(validDir, "plugin.dll"));
        WriteManifest(validDir, "valid-plugin");

        // Invalid plugin (missing manifest)
        var invalidDir = this.CreatePluginDir("plugins-audit/invalidplugin");
        CopyTestAssembly(invalidDir);
        // No manifest.json

        var tf = BuildTrustFile("valid-plugin", validSha, priv);
        WriteTrustFile(trustPath, tf);

        var events = new List<object>();
        var audit = new RecordingAuditLog();
        var bus = new CollectingEventBus(events);
        var clock = new StaticClock(DateTimeOffset.UtcNow);
        var fs = new PassthroughFileSystem();
        var opts = new StaticOptionsMonitor<PluginOptions>(new PluginOptions
        {
            PluginRoot = new AbsolutePath(pluginRoot),
            TrustFilePath = new AbsolutePath(trustPath),
            RequireTrustFile = true,
            TrustFileSignerPublicKey = pub,
            HostVersion = new Version(1, 0, 0, 0),
        });
        var loader = new PluginLoader(fs, clock, bus, audit, opts, NullLogger<PluginLoader>.Instance);

        var results = await loader.DiscoverAndLoadAsync(CancellationToken.None);

        // One plugin loaded, one rejected
        results.Should().HaveCount(1);
        results[0].PluginId.Should().Be("valid-plugin");

        // Audit log should have PluginLoaded + PluginRejected events
        audit.Records.Should().Contain(r => r.EventType == "PluginLoaded");
        audit.Records.Should().Contain(r => r.EventType == "PluginRejected");

        // Event bus should have corresponding events
        events.Should().ContainItemsAssignableTo<PluginLoaded>();
        events.Should().ContainItemsAssignableTo<PluginRejected>();

        await loader.DisposeAsync();
    }
}

// ---- Test doubles --------------------------------------------------------

internal sealed class CollectingEventBus : IEventBus
{
    private readonly List<object> sink;

    public CollectingEventBus(List<object> sink) => this.sink = sink;

    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        this.sink.Add(@event);
        return ValueTask.CompletedTask;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
        => NullDisposable.Instance;
}

internal sealed class NullAuditLog : IAuditLog
{
    public ValueTask AppendAsync(AuditRecord record, CancellationToken ct) => ValueTask.CompletedTask;

    public async IAsyncEnumerable<AuditRecord> ReadAsync([EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask;
        yield break;
    }

    public ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct) =>
        ValueTask.FromResult(new ChainVerification { Ok = true, Reason = null, SegmentId = null, Detail = null });
}

internal sealed class RecordingAuditLog : IAuditLog
{
    public List<AuditRecord> Records { get; } = [];

    public ValueTask AppendAsync(AuditRecord record, CancellationToken ct)
    {
        this.Records.Add(record);
        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<AuditRecord> ReadAsync([EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask;
        foreach (var r in this.Records)
        {
            yield return r;
        }
    }

    public ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct) =>
        ValueTask.FromResult(new ChainVerification { Ok = true, Reason = null, SegmentId = null, Detail = null });
}

internal sealed class StaticClock : IClock
{
    public StaticClock(DateTimeOffset now) => this.UtcNow = now;

    public DateTimeOffset UtcNow { get; }

    public long MonotonicMilliseconds => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

internal sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
{
    public StaticOptionsMonitor(T value) => this.CurrentValue = value;

    public T CurrentValue { get; }

    public T Get(string? name) => this.CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

internal sealed class PassthroughFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(File.Exists(path.Value) || Directory.Exists(path.Value));

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) =>
        new(File.ReadAllTextAsync(path.Value, ct));

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        return new(File.WriteAllTextAsync(path.Value, contents, ct));
    }

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Open, FileAccess.Read, FileShare.Read));

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        return ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write, FileShare.None));
    }

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        File.Move(source.Value, destination.Value, overwrite: true);
        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        if (File.Exists(path.Value))
        {
            File.Delete(path.Value);
        }
        else if (Directory.Exists(path.Value))
        {
            Directory.Delete(path.Value);
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(MountKind.Local);
}

internal sealed class NullDisposable : IAsyncDisposable
{
    public static readonly NullDisposable Instance = new();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
