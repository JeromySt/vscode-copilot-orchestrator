// <copyright file="DiagnoseContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Diagnose;
using AiOrchestrator.Diagnose.Events;
using AiOrchestrator.Diagnose.Pseudonymizer;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.Redaction;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.Options;
using Xunit;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Diagnose.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class DiagnoseContractTests : IDisposable
{
    private readonly string root;

    public DiagnoseContractTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "diag-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.root))
            {
                Directory.Delete(this.root, recursive: true);
            }
        }
        catch
        {
            // best effort
        }
    }

    [Fact]
    [ContractTest("DIAG-1")]
    public async Task DIAG_1_BundleStructureMatches()
    {
        var outputPath = this.MakeOutput("structure.aiodiag");
        var (diagnoser, _, _) = this.MakeDiagnoser();

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);

        using var archive = ZipFile.OpenRead(outputPath.Value);
        var names = archive.Entries.Select(e => e.FullName).ToList();
        names.Should().Contain(new[] { "manifest.json", "plan.json", "events.jsonl", "audit.jsonl", "host.json" });

        var manifestEntry = archive.GetEntry("manifest.json");
        manifestEntry.Should().NotBeNull();
        using var ms = manifestEntry!.Open();
        using var doc = JsonDocument.Parse(ms);
        doc.RootElement.GetProperty("schemaVersion").GetString().Should().Be("1.0");
        doc.RootElement.GetProperty("pseudonymizationMode").GetString().Should().Be("Anonymous");
        doc.RootElement.GetProperty("entries").ValueKind.Should().Be(JsonValueKind.Array);
    }

    [Fact]
    [ContractTest("DIAG-RECIP-1")]
    public async Task DIAG_RECIP_1_AnonymousModePseudonymsStable()
    {
        var outputPath = this.MakeOutput("anon.aiodiag");
        var opts = new StaticOptions(new DiagnoseOptions
        {
            PseudonymizationMode = PseudonymizationMode.Anonymous,
        });
        var (diagnoser, _, _) = this.MakeDiagnoser(opts);

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);

        var hostA = ExtractText(outputPath.Value, "host.json");
        hostA.Should().MatchRegex(@"""userName"":""user-[0-9A-F]{4}""");
        hostA.Should().MatchRegex(@"""hostName"":""host-[0-9A-F]{4}""");

        // Same input → same pseudonym: produce a SECOND bundle with same request settings.
        var outputPath2 = this.MakeOutput("anon2.aiodiag");
        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath2 },
            CancellationToken.None);

        var hostB = ExtractText(outputPath2.Value, "host.json");
        hostB.Should().Be(hostA);
    }

    [Fact]
    [ContractTest("DIAG-RECIP-2")]
    public async Task DIAG_RECIP_2_ReversibleEncryptedToRecipientOnly()
    {
        using var rsa = RSA.Create(2048);
        var publicKey = rsa.ExportSubjectPublicKeyInfo();
        var privateKey = rsa.ExportPkcs8PrivateKey();
        var fingerprint = "recipient-A";

        var outputPath = this.MakeOutput("rev.aiodiag");
        var opts = new StaticOptions(new DiagnoseOptions
        {
            PseudonymizationMode = PseudonymizationMode.Reversible,
            RecipientTrustStore = new Dictionary<string, byte[]> { [fingerprint] = publicKey },
        });
        var (diagnoser, _, _) = this.MakeDiagnoser(opts);

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath, Recipient = fingerprint },
            CancellationToken.None);

        var mappingBytes = ExtractBytes(outputPath.Value, "mapping.encrypted.bin");
        mappingBytes.Should().NotBeEmpty();

        // Decrypt with correct key — succeeds.
        var decoded = MappingTableEncryptor.TryDecrypt(mappingBytes, fingerprint, privateKey);
        decoded.Should().NotBeNull();
        decoded!.Values.Should().OnlyContain(v => v.Contains('-', StringComparison.Ordinal));

        // Decrypt with a DIFFERENT recipient key — fails.
        using var otherRsa = RSA.Create(2048);
        var wrongPrivate = otherRsa.ExportPkcs8PrivateKey();
        var decodedWrong = MappingTableEncryptor.TryDecrypt(mappingBytes, fingerprint, wrongPrivate);
        decodedWrong.Should().BeNull("only the configured recipient can reverse the mapping");
    }

    [Fact]
    [ContractTest("DIAG-RECIP-3")]
    public async Task DIAG_RECIP_3_OffModeRequiresAllowPiiFlag()
    {
        var outputPath = this.MakeOutput("off.aiodiag");
        var opts = new StaticOptions(new DiagnoseOptions { PseudonymizationMode = PseudonymizationMode.Off });
        var (diagnoser, _, _) = this.MakeDiagnoser(opts);

        // Without --allow-pii → throws.
        var act = async () => await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);
        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("*allow-pii*");

        // With --allow-pii → succeeds, and manifest records the warning.
        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath, AllowPii = true },
            CancellationToken.None);

        var manifestText = ExtractText(outputPath.Value, "manifest.json");
        manifestText.Should().Contain("allow-pii");
    }

    [Fact]
    [ContractTest("DIAG-PIPELINE")]
    public async Task DIAG_REDACTOR_RunsBeforePseudonymizer()
    {
        // The redactor replaces a GitHub PAT with [REDACTED]. If the pseudonymizer ran first,
        // the PAT would become a pseudonym and the redactor wouldn't see it. We assert the
        // secret does NOT survive in any form in the output.
        var secret = "ghp_" + new string('A', 36);
        await using var planStore = this.MakePlanStore();
        var planId = await planStore.CreateAsync(
            new PlanModel
            {
                Name = "p",
                Description = $"Token: {secret} and email admin@example.com",
                Status = PlanStatus.Pending,
            },
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        var outputPath = this.MakeOutput("pipeline.aiodiag");
        var (diagnoser, _, _) = this.MakeDiagnoser(planStore: planStore);

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = planId, OutputPath = outputPath },
            CancellationToken.None);

        var planText = ExtractText(outputPath.Value, "plan.json");
        planText.Should().NotContain(secret, "redactor must run BEFORE pseudonymizer (INV-5)");
        planText.Should().Contain("REDACTED");
        planText.Should().MatchRegex(@"email-[0-9A-F]{4}", "email addresses must be pseudonymized after redaction");
    }

    [Fact]
    [ContractTest("DIAG-AUDIT")]
    public async Task DIAG_AUDIT_ProductionEmitsEvent()
    {
        var outputPath = this.MakeOutput("audit.aiodiag");
        var observer = new CapturingObserver();
        var (diagnoser, _, _) = this.MakeDiagnoser(observer: observer);

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);

        observer.Captured.Should().HaveCount(1);
        var ev = observer.Captured[0];
        ev.OutputPath.Should().Be(outputPath.Value);
        ev.ManifestSha256.Should().MatchRegex("^[0-9a-f]{64}$");
    }

    [Fact]
    [ContractTest("DIAG-DETERM")]
    public async Task DIAG_DETERMINISTIC_SameInputsBitIdentical()
    {
        var fixedTime = new DateTimeOffset(2025, 1, 15, 12, 0, 0, TimeSpan.Zero);
        var outputPath1 = this.MakeOutput("det1.aiodiag");
        var outputPath2 = this.MakeOutput("det2.aiodiag");

        var (diagnoser1, _, _) = this.MakeDiagnoser();
        var (diagnoser2, _, _) = this.MakeDiagnoser();

        var request1 = new DiagnoseRequest
        {
            PlanId = null,
            OutputPath = outputPath1,
            OverrideCreatedAt = fixedTime,
        };
        var request2 = new DiagnoseRequest
        {
            PlanId = null,
            OutputPath = outputPath2,
            OverrideCreatedAt = fixedTime,
        };

        await diagnoser1.ProduceBundleAsync(request1, CancellationToken.None);
        await diagnoser2.ProduceBundleAsync(request2, CancellationToken.None);

        var bytes1 = File.ReadAllBytes(outputPath1.Value);
        var bytes2 = File.ReadAllBytes(outputPath2.Value);
        bytes1.Should().BeEquivalentTo(bytes2, "identical inputs must produce byte-identical bundles (INV-8)");
    }

    [Fact]
    [ContractTest("DIAG-ENV")]
    public async Task DIAG_PROCESS_ENV_ExcludedByDefault()
    {
        var outputPath = this.MakeOutput("env.aiodiag");
        var (diagnoser, _, _) = this.MakeDiagnoser();

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);

        using var archive = ZipFile.OpenRead(outputPath.Value);
        archive.GetEntry("env.json").Should().BeNull("env vars must be excluded unless explicitly opted in (INV-7)");

        // When opted in, env.json is present AND a warning is recorded.
        var outputPath2 = this.MakeOutput("env2.aiodiag");
        var opts = new StaticOptions(new DiagnoseOptions
        {
            PseudonymizationMode = PseudonymizationMode.Anonymous,
            IncludeProcessEnv = true,
        });
        var (d2, _, _) = this.MakeDiagnoser(opts);
        await d2.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath2 },
            CancellationToken.None);

        using var archive2 = ZipFile.OpenRead(outputPath2.Value);
        archive2.GetEntry("env.json").Should().NotBeNull();

        var manifestText = ExtractText(outputPath2.Value, "manifest.json");
        manifestText.Should().Contain("Process environment");
    }

    [Fact]
    [ContractTest("DIAG-PATH")]
    public async Task DIAG_PATH_ValidatedThroughIPathValidator()
    {
        var validator = new CountingValidator();
        var outputPath = this.MakeOutput("path.aiodiag");
        var (diagnoser, _, _) = this.MakeDiagnoser(pathValidator: validator);

        await diagnoser.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = outputPath },
            CancellationToken.None);

        validator.Calls.Should().BeGreaterThan(0, "path validator must be invoked on output path (INV-9)");

        // Rejection path: if the validator throws, the bundle must not be created.
        var failing = new ThrowingValidator();
        var (d2, _, _) = this.MakeDiagnoser(pathValidator: failing);
        var bad = this.MakeOutput("bad.aiodiag");
        var act = async () => await d2.ProduceBundleAsync(
            new DiagnoseRequest { PlanId = null, OutputPath = bad },
            CancellationToken.None);
        await act.Should().ThrowAsync<UnauthorizedAccessException>();
        File.Exists(bad.Value).Should().BeFalse();
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private AbsolutePath MakeOutput(string name) => new(Path.Combine(this.root, name));

    private PlanStore MakePlanStore()
    {
        var clock = new InMemoryClock();
        var fs = new NullFileSystem();
        var bus = new NullEventBus();
        var planStoreDir = Path.Combine(this.root, "plans");
        Directory.CreateDirectory(planStoreDir);
        var opts = new StaticOptionsMonitor<PlanStoreOptions>(new PlanStoreOptions());
        return new PlanStore(
            new AbsolutePath(planStoreDir),
            fs,
            clock,
            bus,
            opts,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<PlanStore>.Instance);
    }

    private (Diagnoser, StubAuditLog, StubEventReader) MakeDiagnoser(
        IOptionsMonitor<DiagnoseOptions>? opts = null,
        PlanStore? planStore = null,
        IDiagnoseObserver? observer = null,
        IPathValidator? pathValidator = null)
    {
        opts ??= new StaticOptions(new DiagnoseOptions { PseudonymizationMode = PseudonymizationMode.Anonymous });
        planStore ??= this.MakePlanStore();
        var reader = new StubEventReader();
        var audit = new StubAuditLog();
        var redactor = new AiOrchestrator.Redaction.RedactorPipeline(new List<ISecretDetector>
        {
            new AiOrchestrator.Redaction.Detectors.GitHubPatDetector(),
            new AiOrchestrator.Redaction.Detectors.GenericSecretDetector(),
        });
        var diagnoser = new Diagnoser(
            planStore,
            reader,
            audit,
            redactor,
            new NullFileSystem(),
            new InMemoryClock(new DateTimeOffset(2025, 1, 15, 12, 0, 0, TimeSpan.Zero)),
            opts,
            pathValidator,
            observer);
        return (diagnoser, audit, reader);
    }

    private static string ExtractText(string zipPath, string entryName)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var entry = archive.GetEntry(entryName) ?? throw new InvalidOperationException($"entry {entryName} missing");
        using var s = entry.Open();
        using var sr = new StreamReader(s, Encoding.UTF8);
        return sr.ReadToEnd();
    }

    private static byte[] ExtractBytes(string zipPath, string entryName)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var entry = archive.GetEntry(entryName) ?? throw new InvalidOperationException($"entry {entryName} missing");
        using var s = entry.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }
}

// ─────────────────────────────── stubs ───────────────────────────────

internal sealed class StaticOptions : IOptionsMonitor<DiagnoseOptions>
{
    private readonly DiagnoseOptions value;

    public StaticOptions(DiagnoseOptions value) => this.value = value;

    public DiagnoseOptions CurrentValue => this.value;

    public DiagnoseOptions Get(string? name) => this.value;

    public IDisposable OnChange(Action<DiagnoseOptions, string?> listener) => new NoopDisposable();

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}

internal sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    private readonly T value;

    public StaticOptionsMonitor(T value) => this.value = value;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable OnChange(Action<T, string?> listener) => new NoopDisposable();

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}

internal sealed class StubEventReader : IEventReader
{
    public List<EventEnvelope> Events { get; } = new();

    public async IAsyncEnumerable<EventEnvelope> ReadReplayAndLiveAsync(EventFilter filter, [EnumeratorCancellation] CancellationToken ct)
    {
        foreach (var e in this.Events)
        {
            yield return e;
            await Task.Yield();
        }
    }
}

internal sealed class StubAuditLog : AiOrchestrator.Audit.IAuditLog
{
    public List<AiOrchestrator.Audit.AuditRecord> Records { get; } = new();

    public ValueTask AppendAsync(AiOrchestrator.Audit.AuditRecord record, CancellationToken ct)
    {
        this.Records.Add(record);
        return default;
    }

    public async IAsyncEnumerable<AiOrchestrator.Audit.AuditRecord> ReadAsync([EnumeratorCancellation] CancellationToken ct)
    {
        foreach (var r in this.Records)
        {
            yield return r;
            await Task.Yield();
        }
    }

    public ValueTask<AiOrchestrator.Audit.Trust.ChainVerification> VerifyAsync(AiOrchestrator.Audit.Trust.VerifyMode mode, CancellationToken ct)
        => new(new AiOrchestrator.Audit.Trust.ChainVerification { Ok = true });
}

internal sealed class CapturingObserver : IDiagnoseObserver
{
    public List<DiagnoseBundleProduced> Captured { get; } = new();

    public void OnBundleProduced(DiagnoseBundleProduced produced) => this.Captured.Add(produced);
}

internal sealed class CountingValidator : IPathValidator
{
    public int Calls;

    public void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot) => Interlocked.Increment(ref this.Calls);

    public ValueTask<Stream> OpenReadUnderRootAsync(AbsolutePath allowedRoot, RelativePath relative, CancellationToken ct)
        => new((Stream)new MemoryStream());
}

internal sealed class ThrowingValidator : IPathValidator
{
    public void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot) => throw new UnauthorizedAccessException("blocked");

    public ValueTask<Stream> OpenReadUnderRootAsync(AbsolutePath allowedRoot, RelativePath relative, CancellationToken ct)
        => throw new UnauthorizedAccessException("blocked");
}

internal sealed class NullFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(false);

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(string.Empty);

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => default;

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => default;

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
}

internal sealed class NullEventBus : IEventBus
{
    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull => default;

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => new NullDisposable();

    private sealed class NullDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => default;
    }
}
