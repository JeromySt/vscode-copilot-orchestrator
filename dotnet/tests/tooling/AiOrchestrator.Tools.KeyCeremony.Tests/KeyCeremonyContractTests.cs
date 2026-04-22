// <copyright file="KeyCeremonyContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Tools.KeyCeremony.Tests;

public sealed class KeyCeremonyContractTests
{
    private static CeremonyOrchestrator NewOrchestrator(
        FakeHsmClient hsm,
        FakeNetworkProbe probe,
        ITransparencyLogClient? tl = null)
    {
        tl ??= new StubTransparencyLogClient("MERKLE-RECEIPT-XYZ");
        return new CeremonyOrchestrator(
            hsm,
            new DiskFileSystem(),
            new TestClock(),
            NullLogger<CeremonyOrchestrator>.Instance,
            probe,
            tl);
    }

    private static CeremonyRequest NewRequest(string workDir, string[] signers, bool allowNetwork = true)
    {
        var unsigned = CeremonyTestEnv.WriteUnsignedManifest(workDir);
        var transcriptDir = Path.Combine(workDir, "audit");
        Directory.CreateDirectory(transcriptDir);
        return new CeremonyRequest
        {
            UnsignedManifestPath = new AbsolutePath(unsigned),
            OutputSignedPath = new AbsolutePath(Path.Combine(workDir, "release-manifest.signed.json")),
            RequiredSigners = signers.Select(s => new HsmOperatorId(s)).ToImmutableArray(),
            CeremonyTranscriptPath = Path.Combine(transcriptDir, "ceremony.log"),
            SubmitToTransparencyLog = true,
            AllowNetwork = allowNetwork,
        };
    }

    [Fact]
    [ContractTest("CER-1")]
    public async Task CER_1_RefusesToRunIfNetworkUp_NoOverride()
    {
        var dir = CeremonyTestEnv.NewWorkDir();
        var hsm = new FakeHsmClient();
        var probe = new FakeNetworkProbe { NetworkUp = true };
        var orch = NewOrchestrator(hsm, probe);
        var req = NewRequest(dir, new[] { "op1", "op2", "op3" }, allowNetwork: false);

        Func<Task> act = async () => await orch.RunAsync(req, CancellationToken.None);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(act); Assert.Contains("network interface", ex.Message);
    }

    [Fact]
    [ContractTest("CER-2")]
    public async Task CER_2_BatchSigningRefused()
    {
        var dir = CeremonyTestEnv.NewWorkDir();
        var hsm = new FakeHsmClient();
        var probe = new FakeNetworkProbe { NetworkUp = false };
        var orch = NewOrchestrator(hsm, probe);
        var req = NewRequest(dir, new[] { "op1", "op2", "op1" });

        Func<Task> act = async () => await orch.RunAsync(req, CancellationToken.None);

        await Assert.ThrowsAsync<BatchSigningException>(act);
    }

    [Fact]
    [ContractTest("CER-3")]
    public async Task CER_3_TranscriptWrittenSeparateFs()
    {
        var dir = CeremonyTestEnv.NewWorkDir();
        var hsm = new FakeHsmClient();
        var probe = new FakeNetworkProbe { NetworkUp = false };
        var orch = NewOrchestrator(hsm, probe);
        var req = NewRequest(dir, new[] { "op1", "op2", "op3" });

        var result = await orch.RunAsync(req, CancellationToken.None);

        Assert.True(File.Exists(req.CeremonyTranscriptPath));
        var transcriptDir = Path.GetDirectoryName(req.CeremonyTranscriptPath);
        var manifestDir = Path.GetDirectoryName(req.OutputSignedPath.Value);
        Assert.NotEqual(manifestDir, transcriptDir);

        var contents = File.ReadAllText(req.CeremonyTranscriptPath);
        Assert.Contains("op1", contents);
        Assert.Contains("op2", contents);
        Assert.Contains("op3", contents);
        Assert.Contains("payloadSha256", contents);
        Assert.Equal(3, result.ActualSigners.Length);
    }

    [Fact]
    [ContractTest("CER-4")]
    public async Task CER_4_OutputManifestSchemaValid()
    {
        var dir = CeremonyTestEnv.NewWorkDir();
        var hsm = new FakeHsmClient();
        var probe = new FakeNetworkProbe { NetworkUp = false };
        var orch = NewOrchestrator(hsm, probe);
        var req = NewRequest(dir, new[] { "op1", "op2", "op3" });

        await orch.RunAsync(req, CancellationToken.None);

        Assert.True(File.Exists(req.OutputSignedPath.Value));
        var json = File.ReadAllText(req.OutputSignedPath.Value);
        var roundTrip = System.Text.Json.JsonSerializer.Deserialize<AiOrchestrator.Daemon.Update.SignedReleaseManifest>(json);
        Assert.NotNull(roundTrip);
        Assert.False(roundTrip!.Artifacts.IsDefaultOrEmpty);
        Assert.True(roundTrip.Signatures.Length >= req.RequiredSigners.Length);
        Assert.NotNull(roundTrip.Version);
        Assert.NotNull(roundTrip.MinSupportedVersion);
    }

    [Fact]
    [ContractTest("CER-5")]
    public async Task CER_5_TransparencyLogSubmissionEmbedsProof()
    {
        var dir = CeremonyTestEnv.NewWorkDir();
        var hsm = new FakeHsmClient();
        var probe = new FakeNetworkProbe { NetworkUp = false };
        var tl = new StubTransparencyLogClient("MERKLE-RECEIPT-XYZ");
        var orch = NewOrchestrator(hsm, probe, tl);
        var req = NewRequest(dir, new[] { "op1", "op2", "op3" });

        var result = await orch.RunAsync(req, CancellationToken.None);

        Assert.Equal("MERKLE-RECEIPT-XYZ", result.TransparencyLogReceipt);
        var json = File.ReadAllText(req.OutputSignedPath.Value);
        Assert.Contains("MERKLE-RECEIPT-XYZ", json);
        Assert.Contains("TransparencyLogProof", json);
    }
}
