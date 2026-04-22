// <copyright file="ReleaseManifestFetcher.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Audit.Crypto;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.Update;

/// <summary>Fetches and verifies the signed release manifest. Daemon-side; never signs.</summary>
internal sealed class ReleaseManifestFetcher
{
    private static readonly Ed25519Signer Verifier = new();

    private readonly IHttpClientFactory httpFactory;
    private readonly ILogger<ReleaseManifestFetcher> logger;

    public ReleaseManifestFetcher(IHttpClientFactory httpFactory, ILogger<ReleaseManifestFetcher> logger)
    {
        ArgumentNullException.ThrowIfNull(httpFactory);
        ArgumentNullException.ThrowIfNull(logger);
        this.httpFactory = httpFactory;
        this.logger = logger;
    }

    public async ValueTask<SignedReleaseManifest> FetchAsync(string url, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(url);
        using var client = this.httpFactory.CreateClient(nameof(ReleaseManifestFetcher));
        var json = await client.GetStringAsync(new Uri(url), ct).ConfigureAwait(false);
        var dto = JsonSerializer.Deserialize(json, ManifestJsonContext.Default.ManifestDto)
                  ?? throw new InvalidOperationException("Manifest JSON deserialized to null.");
        this.logger.LogInformation("Fetched manifest version {Version} ({SigCount} signatures)", dto.Version, dto.Signatures?.Length ?? 0);
        return Convert(dto);
    }

    public ValueTask<bool> VerifyAsync(SignedReleaseManifest mfst, byte[] offlineRootPubKey, int minValid, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(mfst);
        ArgumentNullException.ThrowIfNull(offlineRootPubKey);
        _ = ct;

        if (offlineRootPubKey.Length == 0 || mfst.Signatures.IsDefaultOrEmpty)
        {
            return ValueTask.FromResult(false);
        }

        var payload = CanonicalPayload(mfst);
        var valid = 0;
        foreach (var sig in mfst.Signatures)
        {
            try
            {
                if (Verifier.Verify(payload, sig.Signature, offlineRootPubKey))
                {
                    valid++;
                }
            }
            catch (Exception ex)
            {
                this.logger.LogDebug(ex, "Signature verification threw for keyId {KeyId}", sig.KeyId);
            }
        }

        return ValueTask.FromResult(valid >= minValid);
    }

    internal static byte[] CanonicalPayload(SignedReleaseManifest mfst)
    {
        var sb = new StringBuilder();
        sb.Append(mfst.Version).Append('|')
          .Append(mfst.MinSupportedVersion).Append('|')
          .Append(mfst.SignedAt.ToUnixTimeSeconds()).Append('|');
        foreach (var a in mfst.Artifacts)
        {
            sb.Append(a.Filename).Append(':').Append(a.Sha256).Append(':').Append(a.Bytes).Append(';');
        }

        sb.Append('|');
        foreach (var k in mfst.TrustedAuditPubKeys)
        {
            sb.Append(System.Convert.ToHexString(k)).Append(',');
        }

        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static SignedReleaseManifest Convert(ManifestDto dto)
    {
        var artifacts = (dto.Artifacts ?? Array.Empty<ArtifactDto>())
            .Select(a => new DaemonArtifact
            {
                Filename = a.Filename ?? string.Empty,
                Sha256 = a.Sha256 ?? string.Empty,
                Bytes = a.Bytes,
                DownloadUrl = new Uri(a.DownloadUrl ?? "about:blank"),
            }).ToImmutableArray();
        var sigs = (dto.Signatures ?? Array.Empty<SignatureDto>())
            .Select(s => new HsmSignature { KeyId = s.KeyId ?? string.Empty, Signature = s.Signature ?? Array.Empty<byte>() })
            .ToImmutableArray();
        var keys = (dto.TrustedAuditPubKeys ?? Array.Empty<byte[]>()).ToImmutableArray();

        return new SignedReleaseManifest
        {
            Version = Version.Parse(dto.Version ?? "0.0.0"),
            MinSupportedVersion = Version.Parse(dto.MinSupportedVersion ?? "0.0.0"),
            Artifacts = artifacts,
            SignedAt = DateTimeOffset.FromUnixTimeSeconds(dto.SignedAtUnix),
            Signatures = sigs,
            TrustedAuditPubKeys = keys,
        };
    }

    internal sealed class ManifestDto
    {
        public string? Version { get; set; }

        public string? MinSupportedVersion { get; set; }

        public long SignedAtUnix { get; set; }

        public ArtifactDto[]? Artifacts { get; set; }

        public SignatureDto[]? Signatures { get; set; }

        public byte[][]? TrustedAuditPubKeys { get; set; }
    }

    internal sealed class ArtifactDto
    {
        public string? Filename { get; set; }

        public string? Sha256 { get; set; }

        public long Bytes { get; set; }

        public string? DownloadUrl { get; set; }
    }

    internal sealed class SignatureDto
    {
        public string? KeyId { get; set; }

        public byte[]? Signature { get; set; }
    }
}

[JsonSerializable(typeof(ReleaseManifestFetcher.ManifestDto))]
[JsonSerializable(typeof(ReleaseManifestFetcher.ArtifactDto))]
[JsonSerializable(typeof(ReleaseManifestFetcher.SignatureDto))]
internal sealed partial class ManifestJsonContext : JsonSerializerContext
{
}
