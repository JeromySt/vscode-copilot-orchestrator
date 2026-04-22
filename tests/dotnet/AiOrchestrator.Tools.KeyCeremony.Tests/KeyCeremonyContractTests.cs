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
using FluentAssertions;
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

        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("*network interface*");
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

        await act.Should().ThrowAsync<BatchSigningException>();
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

        File.Exists(req.CeremonyTranscriptPath).Should().BeTrue();
        var transcriptDir = Path.GetDirectoryName(req.CeremonyTranscriptPath);
        var manifestDir = Path.GetDirectoryName(req.OutputSignedPath.Value);
        transcriptDir.Should().NotBe(manifestDir);

        var contents = File.ReadAllText(req.CeremonyTranscriptPath);
        contents.Should().Contain("op1");
        contents.Should().Contain("op2");
        contents.Should().Contain("op3");
        contents.Should().Contain("payloadSha256");
        result.ActualSigners.Should().HaveCount(3);
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

        File.Exists(req.OutputSignedPath.Value).Should().BeTrue();
        var json = File.ReadAllText(req.OutputSignedPath.Value);
        var roundTrip = System.Text.Json.JsonSerializer.Deserialize<AiOrchestrator.Daemon.Update.SignedReleaseManifest>(json);
        roundTrip.Should().NotBeNull();
        roundTrip!.Artifacts.IsDefaultOrEmpty.Should().BeFalse();
        roundTrip.Signatures.Length.Should().BeGreaterOrEqualTo(req.RequiredSigners.Length);
        roundTrip.Version.Should().NotBeNull();
        roundTrip.MinSupportedVersion.Should().NotBeNull();
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

        result.TransparencyLogReceipt.Should().Be("MERKLE-RECEIPT-XYZ");
        var json = File.ReadAllText(req.OutputSignedPath.Value);
        json.Should().Contain("MERKLE-RECEIPT-XYZ");
        json.Should().Contain("TransparencyLogProof");
    }
}
