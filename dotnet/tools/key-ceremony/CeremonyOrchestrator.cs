// <copyright file="CeremonyOrchestrator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Daemon.Update;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Tools.KeyCeremony.Transcript;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Orchestrates the offline M-of-N HSM signing ceremony.</summary>
internal sealed class CeremonyOrchestrator
{
    private readonly IHsmClient hsm;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly ILogger<CeremonyOrchestrator> logger;
    private readonly INetworkProbe networkProbe;
    private readonly ITransparencyLogClient transparencyLog;

    /// <summary>Initializes a new instance of the <see cref="CeremonyOrchestrator"/> class.</summary>
    /// <param name="hsm">The HSM client.</param>
    /// <param name="fs">The filesystem abstraction.</param>
    /// <param name="clock">The clock used for timestamps.</param>
    /// <param name="logger">The logger.</param>
    public CeremonyOrchestrator(IHsmClient hsm, IFileSystem fs, IClock clock, ILogger<CeremonyOrchestrator> logger)
        : this(hsm, fs, clock, logger, new DefaultNetworkProbe(), new StubTransparencyLogClient())
    {
    }

    /// <summary>Initializes a new instance of the <see cref="CeremonyOrchestrator"/> class with full DI.</summary>
    /// <param name="hsm">The HSM client.</param>
    /// <param name="fs">The filesystem abstraction.</param>
    /// <param name="clock">The clock used for timestamps.</param>
    /// <param name="logger">The logger.</param>
    /// <param name="networkProbe">Network up/down probe.</param>
    /// <param name="transparencyLog">Transparency-log client.</param>
    internal CeremonyOrchestrator(
        IHsmClient hsm,
        IFileSystem fs,
        IClock clock,
        ILogger<CeremonyOrchestrator> logger,
        INetworkProbe networkProbe,
        ITransparencyLogClient transparencyLog)
    {
        this.hsm = hsm;
        this.fs = fs;
        this.clock = clock;
        this.logger = logger ?? NullLogger<CeremonyOrchestrator>.Instance;
        this.networkProbe = networkProbe;
        this.transparencyLog = transparencyLog;
    }

    /// <summary>Runs the ceremony end-to-end.</summary>
    /// <param name="request">The ceremony request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The ceremony result.</returns>
    public async ValueTask<CeremonyResult> RunAsync(CeremonyRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        // INV-1: refuse to start if the host is not air-gapped.
        if (this.networkProbe.NetworkUp && !request.AllowNetwork)
        {
            throw new InvalidOperationException(
                "Refusing to start ceremony: a non-loopback network interface is up. " +
                "Air-gap the host or pass --allow-network for staging only.");
        }

        // INV-2: each operator must appear at most once. Duplicate => batch-signing attempt.
        if (request.RequiredSigners.Length == 0)
        {
            throw new ArgumentException("RequiredSigners must not be empty.", nameof(request));
        }

        var distinct = new HashSet<string>(StringComparer.Ordinal);
        foreach (var s in request.RequiredSigners)
        {
            if (!distinct.Add(s.Value))
            {
                throw new BatchSigningException(
                    $"Operator '{s.Value}' appears multiple times in RequiredSigners; batch signing is forbidden.");
            }
        }

        var transcriptPath = new AbsolutePath(request.CeremonyTranscriptPath);
        var transcript = new CeremonyTranscriptWriter(transcriptPath.Value, this.fs, this.clock);
        await transcript.EnsureDirectoryAsync(ct).ConfigureAwait(false);

        // INV-4: load + parse the unsigned manifest.
        var unsignedJson = await this.fs.ReadAllTextAsync(request.UnsignedManifestPath, ct).ConfigureAwait(false);
        var unsigned = JsonSerializer.Deserialize<UnsignedReleaseManifest>(unsignedJson)
            ?? throw new InvalidDataException("Unsigned manifest could not be parsed.");

        var payloadBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            unsigned.Version,
            unsigned.Artifacts,
            unsigned.SignedAt,
            unsigned.MinSupportedVersion,
            unsigned.TrustedAuditPubKeys,
        }));
        var payloadHashBytes = SHA256.HashData(payloadBytes);
        var payloadHashHex = Convert.ToHexString(payloadHashBytes).ToLowerInvariant();

        var signatures = ImmutableArray.CreateBuilder<HsmSignature>();
        var actualSigners = ImmutableArray.CreateBuilder<HsmOperatorId>();
        var signedOnce = new HashSet<string>(StringComparer.Ordinal);

        foreach (var op in request.RequiredSigners)
        {
            ct.ThrowIfCancellationRequested();
            this.logger.LogInformation("Connecting to HSM for operator {Operator}", op.Value);
            var device = await this.hsm.ConnectAsync(op, ct).ConfigureAwait(false);
            await transcript.AppendAsync("connect", op, device.DeviceSerial, string.Empty, ct).ConfigureAwait(false);

            // INV-2: refuse a second sign on the same operator within one ceremony.
            if (!signedOnce.Add(op.Value))
            {
                throw new BatchSigningException(
                    $"Operator '{op.Value}' attempted a second sign within one ceremony.");
            }

            var sig = await this.hsm.SignAsync(op, payloadHashBytes, ct).ConfigureAwait(false);
            await transcript.AppendAsync("sign", op, device.DeviceSerial, payloadHashHex, ct).ConfigureAwait(false);

            signatures.Add(new HsmSignature
            {
                KeyId = device.KeyId,
                Signature = sig,
            });
            actualSigners.Add(op);

            await this.hsm.DisconnectAsync(op, ct).ConfigureAwait(false);
            await transcript.AppendAsync("disconnect", op, device.DeviceSerial, string.Empty, ct).ConfigureAwait(false);
        }

        // INV-5: optional transparency log submission.
        string? receipt = null;
        if (request.SubmitToTransparencyLog)
        {
            receipt = await this.transparencyLog.SubmitAsync(payloadBytes, request.TransparencyLogUrl, ct).ConfigureAwait(false);
        }

        // INV-4: serialise as SignedReleaseManifest and validate before write.
        var signed = new SignedReleaseManifest
        {
            Version = unsigned.Version ?? new Version(0, 0, 0),
            Artifacts = unsigned.Artifacts.IsDefault ? ImmutableArray<DaemonArtifact>.Empty : unsigned.Artifacts,
            SignedAt = unsigned.SignedAt == default ? this.clock.UtcNow : unsigned.SignedAt,
            Signatures = signatures.ToImmutable(),
            MinSupportedVersion = unsigned.MinSupportedVersion ?? new Version(0, 0, 0),
            TrustedAuditPubKeys = unsigned.TrustedAuditPubKeys.IsDefault
                ? ImmutableArray<byte[]>.Empty
                : unsigned.TrustedAuditPubKeys,
        };

        // Augment with transparency-log receipt for INV-5 (carried in same JSON object).
        var output = new SignedReleaseManifestEnvelope
        {
            Version = signed.Version,
            Artifacts = signed.Artifacts,
            SignedAt = signed.SignedAt,
            Signatures = signed.Signatures,
            MinSupportedVersion = signed.MinSupportedVersion,
            TrustedAuditPubKeys = signed.TrustedAuditPubKeys,
            TransparencyLogProof = receipt,
        };

        var outJson = JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true });

        // Validate by round-tripping through the canonical record.
        var roundTrip = JsonSerializer.Deserialize<SignedReleaseManifest>(outJson)
            ?? throw new InvalidOperationException("Round-trip deserialization of signed manifest failed.");
        if (roundTrip.Signatures.Length < request.RequiredSigners.Length)
        {
            throw new InvalidOperationException("Signed manifest has fewer signatures than required signers.");
        }

        if (roundTrip.Artifacts.IsDefault)
        {
            throw new InvalidOperationException("Signed manifest Artifacts is default.");
        }

        await this.fs.WriteAllTextAsync(request.OutputSignedPath, outJson, ct).ConfigureAwait(false);

        return new CeremonyResult
        {
            SignedManifestPath = request.OutputSignedPath,
            ActualSigners = actualSigners.ToImmutable(),
            TransparencyLogReceipt = receipt,
            TranscriptPath = transcriptPath,
        };
    }

    /// <summary>Internal envelope mirroring <see cref="SignedReleaseManifest"/> + transparency log proof.</summary>
    private sealed record SignedReleaseManifestEnvelope
    {
        public required Version Version { get; init; }

        public required ImmutableArray<DaemonArtifact> Artifacts { get; init; }

        public required DateTimeOffset SignedAt { get; init; }

        public required ImmutableArray<HsmSignature> Signatures { get; init; }

        public required Version MinSupportedVersion { get; init; }

        public required ImmutableArray<byte[]> TrustedAuditPubKeys { get; init; }

        public string? TransparencyLogProof { get; init; }
    }

    /// <summary>Wire format of the unsigned manifest input file.</summary>
    private sealed record UnsignedReleaseManifest
    {
        public Version? Version { get; init; }

        public ImmutableArray<DaemonArtifact> Artifacts { get; init; }

        public DateTimeOffset SignedAt { get; init; }

        public Version? MinSupportedVersion { get; init; }

        public ImmutableArray<byte[]> TrustedAuditPubKeys { get; init; }
    }
}
