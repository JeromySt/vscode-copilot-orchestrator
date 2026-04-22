// <copyright file="TestHelpers.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Crypto;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.SkewManifest.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

internal static class KeyFactory
{
    public static (byte[] Priv, byte[] Pub) Generate()
    {
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        return (priv, pub);
    }

    public static byte[] Sign(byte[] message, byte[] priv)
    {
        using var ecdsa = ECDsa.Create();
        ecdsa.ImportPkcs8PrivateKey(priv, out _);
        return ecdsa.SignData(message, HashAlgorithmName.SHA256);
    }
}

internal sealed class FakeOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    public FakeOptionsMonitor(T value) => this.CurrentValue = value;

    public T CurrentValue { get; set; }

    public T Get(string? name) => this.CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

internal sealed class RecordingAuditLog : IAuditLog
{
    public List<AuditRecord> Records { get; } = new();

    public ValueTask AppendAsync(AuditRecord record, CancellationToken ct)
    {
        this.Records.Add(record);
        return default;
    }

    public IAsyncEnumerable<AuditRecord> ReadAsync(CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<AiOrchestrator.Audit.Trust.ChainVerification> VerifyAsync(AiOrchestrator.Audit.Trust.VerifyMode mode, CancellationToken ct) => throw new NotSupportedException();
}

internal sealed class RecordingEventBus : IEventBus
{
    public List<object> Published { get; } = new();

    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        this.Published.Add(@event);
        return default;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => throw new NotSupportedException();
}

internal sealed class StubFileSystem : AiOrchestrator.Abstractions.Io.IFileSystem
{
    public ValueTask<bool> ExistsAsync(AiOrchestrator.Models.Paths.AbsolutePath path, CancellationToken ct) => new(false);

    public ValueTask<string> ReadAllTextAsync(AiOrchestrator.Models.Paths.AbsolutePath path, CancellationToken ct) => new(string.Empty);

    public ValueTask WriteAllTextAsync(AiOrchestrator.Models.Paths.AbsolutePath path, string contents, CancellationToken ct) => default;

    public ValueTask<System.IO.Stream> OpenReadAsync(AiOrchestrator.Models.Paths.AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<System.IO.Stream> OpenWriteExclusiveAsync(AiOrchestrator.Models.Paths.AbsolutePath path, AiOrchestrator.Abstractions.Io.FilePermissions perms, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask MoveAtomicAsync(AiOrchestrator.Models.Paths.AbsolutePath source, AiOrchestrator.Models.Paths.AbsolutePath destination, CancellationToken ct) => default;

    public ValueTask DeleteAsync(AiOrchestrator.Models.Paths.AbsolutePath path, CancellationToken ct) => default;

    public ValueTask<AiOrchestrator.Abstractions.Io.MountKind> GetMountKindAsync(AiOrchestrator.Models.Paths.AbsolutePath path, CancellationToken ct) => new(AiOrchestrator.Abstractions.Io.MountKind.Local);
}

internal sealed class StubHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

    public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => this.respond = respond;

    public int CallCount { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        this.CallCount++;
        return Task.FromResult(this.respond(request));
    }
}

internal sealed class StubHttpClientFactory : IHttpClientFactory
{
    private readonly HttpMessageHandler handler;

    public StubHttpClientFactory(HttpMessageHandler handler) => this.handler = handler;

    public HttpClient CreateClient(string name) => new(this.handler, disposeHandler: false);
}

internal static class ManifestFactory
{
    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = false };

    public static (SkewManifest Manifest, ImmutableArray<byte[]> HsmPublicKeys, ImmutableArray<byte[]> EmergencyPublicKeys) BuildSigned(
        int hsmKeyCount = 5,
        int hsmSignatureCount = 3,
        int emergencyKeyCount = 3,
        int emergencySignatureCount = 0,
        DateTimeOffset? signedAt = null,
        DateTimeOffset? notValidAfter = null,
        Version? manifestVersion = null,
        EmergencyRevocation? revocationTemplate = null,
        bool signEmergencyWithMainKeys = false,
        int unknownSignatureCount = 0)
    {
        var signAt = signedAt ?? DateTimeOffset.UtcNow;
        var expire = notValidAfter ?? signAt.AddDays(7);
        var version = manifestVersion ?? new Version(2, 0);

        var hsmKeys = new List<(byte[] Priv, byte[] Pub)>();
        for (var i = 0; i < hsmKeyCount; i++)
        {
            hsmKeys.Add(KeyFactory.Generate());
        }

        var emergencyKeys = new List<(byte[] Priv, byte[] Pub)>();
        for (var i = 0; i < emergencyKeyCount; i++)
        {
            emergencyKeys.Add(KeyFactory.Generate());
        }

        // Build manifest skeleton with empty signatures and no proof
        var audKey = KeyFactory.Generate();
        var skeleton = new SkewManifest
        {
            SchemaVersion = new Version(1, 0),
            ManifestVersion = version,
            SignedAt = signAt,
            NotValidAfter = expire,
            TrustedAuditPubKeys = ImmutableArray.Create(new TrustedAuditPubKey
            {
                KeyId = "audit-1",
                PublicKey = audKey.Pub,
                NotValidBefore = signAt.AddDays(-1),
                NotValidAfter = expire,
                RevocationReason = null,
            }),
            HsmSignatures = ImmutableArray<HsmSignature>.Empty,
            EmergencyRevocation = revocationTemplate,
            TransparencyLogProof = null,
        };

        // If a revocation template is given, we need to produce its AdditionalSignatures
        // over the "emergency payload" with empty sigs.
        if (skeleton.EmergencyRevocation is not null)
        {
            var keysToSign = signEmergencyWithMainKeys ? hsmKeys : emergencyKeys;
            var emergencyPayload = BuildEmergencyPayload(skeleton.EmergencyRevocation);
            var emerSigs = ImmutableArray.CreateBuilder<HsmSignature>();
            for (var i = 0; i < emergencySignatureCount && i < keysToSign.Count; i++)
            {
                var sig = KeyFactory.Sign(emergencyPayload, keysToSign[i].Priv);
                emerSigs.Add(new HsmSignature
                {
                    HsmId = $"emergency-{i}",
                    Algorithm = "ECDSA-P256",
                    Signature = sig,
                });
            }

            skeleton = skeleton with { EmergencyRevocation = skeleton.EmergencyRevocation with { AdditionalSignatures = emerSigs.ToImmutable() } };
        }

        // Now sign the main canonical payload with HSM keys.
        var payload = BuildCanonicalPayload(skeleton);
        var sigs = ImmutableArray.CreateBuilder<HsmSignature>();
        for (var i = 0; i < hsmSignatureCount && i < hsmKeys.Count; i++)
        {
            var sig = KeyFactory.Sign(payload, hsmKeys[i].Priv);
            sigs.Add(new HsmSignature
            {
                HsmId = $"hsm-{i}",
                Algorithm = "ECDSA-P256",
                Signature = sig,
            });
        }

        for (var i = 0; i < unknownSignatureCount; i++)
        {
            var unknown = KeyFactory.Generate();
            var sig = KeyFactory.Sign(payload, unknown.Priv);
            sigs.Add(new HsmSignature
            {
                HsmId = $"unknown-{i}",
                Algorithm = "ECDSA-P256",
                Signature = sig,
            });
        }

        var final = skeleton with { HsmSignatures = sigs.ToImmutable() };
        return (
            final,
            hsmKeys.ConvertAll(k => k.Pub).ToImmutableArray(),
            emergencyKeys.ConvertAll(k => k.Pub).ToImmutableArray());
    }

    public static string Serialize(SkewManifest manifest) => JsonSerializer.Serialize(manifest, Opts);

    private static byte[] BuildCanonicalPayload(SkewManifest mfst)
    {
        var stripped = mfst with
        {
            HsmSignatures = ImmutableArray<HsmSignature>.Empty,
            TransparencyLogProof = null,
            EmergencyRevocation = mfst.EmergencyRevocation is null
                ? null
                : mfst.EmergencyRevocation with { AdditionalSignatures = ImmutableArray<HsmSignature>.Empty },
        };
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(stripped, Opts));
    }

    private static byte[] BuildEmergencyPayload(EmergencyRevocation rev)
    {
        var stripped = rev with { AdditionalSignatures = ImmutableArray<HsmSignature>.Empty };
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(stripped, Opts));
    }
}
