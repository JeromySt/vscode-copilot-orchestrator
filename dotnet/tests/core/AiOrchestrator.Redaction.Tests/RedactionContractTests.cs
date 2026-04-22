// <copyright file="RedactionContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using AiOrchestrator.Redaction;
using AiOrchestrator.Redaction.Detectors;
using AiOrchestrator.Redaction.Pseudonymization;
using Xunit;

namespace AiOrchestrator.Redaction.Tests;

/// <summary>Marks a test as verifying a specific acceptance-criteria contract.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance with the given rule identifier.</summary>
    /// <param name="id">The rule / invariant identifier, e.g., <c>T3-RED-1</c>.</param>
    public ContractTestAttribute(string id) => Id = id;

    /// <summary>Gets the rule identifier.</summary>
    public string Id { get; }
}

/// <summary>Acceptance-criteria contract tests for the AiOrchestrator.Redaction assembly.</summary>
public sealed class RedactionContractTests
{
    private static RedactorPipeline BuildPipeline() =>
        new(new ISecretDetector[]
        {
            new GitHubPatDetector(),
            new AwsAccessKeyDetector(),
            new ApiKeyDetector(),
            new ConnectionStringDetector(),
            new SshPrivateKeyDetector(),
            new GenericSecretDetector(),
            new JwtDetector(),
            new PathSidDetector(),
        });

    // -----------------------------------------------------------------
    // Detector contract tests
    // -----------------------------------------------------------------

    /// <summary>GitHubPatDetector redacts a GitHub PAT (ghp_ prefix).</summary>
    [Fact]
    [ContractTest("T3-RED-1")]
    public void T3Red1_GitHubPat_IsRedacted()
    {
        var detector = new GitHubPatDetector();
        const string pat = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
        var input = $"Authorization: {pat}";

        var matches = detector.Detect(input);

        Assert.Equal(1, matches.Count);
        Assert.Equal("T3-RED-1", matches[0].RuleId);
        Assert.True(matches[0].Length >= pat.Length);
    }

    /// <summary>AwsAccessKeyDetector redacts an AWS Access Key ID.</summary>
    [Fact]
    [ContractTest("T3-RED-2")]
    public void T3Red2_AwsAccessKey_IsRedacted()
    {
        var detector = new AwsAccessKeyDetector();
        const string awsKey = "AKIAIOSFODNN7EXAMPLE";
        var input = $"export AWS_ACCESS_KEY_ID={awsKey}";

        var matches = detector.Detect(input);

        Assert.Equal(1, matches.Count);
        Assert.Equal("T3-RED-2", matches[0].RuleId);
        Assert.Equal(awsKey.Length, matches[0].Length);
    }

    /// <summary>ApiKeyDetector redacts a Bearer token in an HTTP header.</summary>
    [Fact]
    [ContractTest("T3-RED-3")]
    public void T3Red3_BearerToken_IsRedacted()
    {
        var detector = new ApiKeyDetector();
        const string token = "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        var input = $"Authorization: {token}";

        var matches = detector.Detect(input);

        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("T3-RED-3", m.RuleId));
    }

    /// <summary>ConnectionStringDetector redacts a password embedded in a connection string.</summary>
    [Fact]
    [ContractTest("T3-RED-4")]
    public void T3Red4_ConnectionStringPassword_IsRedacted()
    {
        var detector = new ConnectionStringDetector();
        const string input = "Server=db.example.com;User Id=admin;Password=S3cur3P@ssw0rd!;Database=mydb";

        var matches = detector.Detect(input);

        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("T3-RED-4", m.RuleId));
    }

    /// <summary>SshPrivateKeyDetector redacts a PEM private-key header.</summary>
    [Fact]
    [ContractTest("T3-RED-5")]
    public void T3Red5_SshPrivateKeyHeader_IsRedacted()
    {
        var detector = new SshPrivateKeyDetector();
        const string input = "-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content\n-----END OPENSSH PRIVATE KEY-----";

        var matches = detector.Detect(input);

        Assert.Equal(1, matches.Count);
        Assert.Equal("T3-RED-5", matches[0].RuleId);
    }

    /// <summary>GenericSecretDetector redacts a generic secret assignment.</summary>
    [Fact]
    [ContractTest("T3-RED-6")]
    public void T3Red6_GenericSecret_IsRedacted()
    {
        var detector = new GenericSecretDetector();
        const string input = "password=Sup3rS3cretV@lue123";

        var matches = detector.Detect(input);

        Assert.Equal(1, matches.Count);
        Assert.Equal("T3-RED-6", matches[0].RuleId);
    }

    /// <summary>JwtDetector redacts a JSON Web Token.</summary>
    [Fact]
    [ContractTest("T3-RED-7")]
    public void T3Red7_Jwt_IsRedacted()
    {
        var detector = new JwtDetector();
        const string input = "token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

        var matches = detector.Detect(input);

        Assert.Equal(1, matches.Count);
        Assert.Equal("T3-RED-7", matches[0].RuleId);
    }

    /// <summary>
    /// PathSidDetector detects a Windows user-profile path (P-SID-2) and respects
    /// negative-lookbehind anchoring so it does not match mid-word (INV-5).
    /// </summary>
    [Fact]
    [ContractTest("P-SID-2")]
    public void PSid2_WindowsUserPath_IsDetectedAndAnchored()
    {
        var detector = new PathSidDetector();

        // Should match: standalone path
        var matches = detector.Detect(@"Copying files from C:\Users\testuser\Documents to backup");
        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("P-SID-2", m.RuleId));

        // INV-5: negative-lookbehind must prevent a match when the path is preceded by [A-Za-z0-9]
        var noMatch = detector.Detect("notC:\\Users\\testuser\\Documents");
        Assert.Empty(noMatch);
    }

    // -----------------------------------------------------------------
    // Invariant contract tests
    // -----------------------------------------------------------------

    /// <summary>Redact is idempotent: redacting already-redacted output yields the same string (INV-3).</summary>
    [Fact]
    [ContractTest("INV-3")]
    public void Inv3_Redact_IsIdempotent()
    {
        var pipeline = BuildPipeline();
        const string input = "token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

        var once = pipeline.Redact(input);
        var twice = pipeline.Redact(once);

        Assert.Equal(once, twice);
    }

    /// <summary>Output length never exceeds input length (INV-4).</summary>
    [Fact]
    [ContractTest("INV-4")]
    public void Inv4_RedactedOutput_LengthNonIncrease()
    {
        var pipeline = BuildPipeline();

        var cases = new[]
        {
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
            "AKIAIOSFODNN7EXAMPLE",
            "password=Sup3rS3cretV@lue123",
            @"C:\Users\testuser\Documents\report.docx",
            "No secrets here — plain text.",
        };

        foreach (var input in cases)
        {
            var output = pipeline.Redact(input);
            Assert.True(output.Length <= input.Length,
                $"output must not grow for input: {input[..Math.Min(40, input.Length)]}");
        }
    }

    /// <summary>Anonymous-mode pseudonyms are deterministic for the same bundle salt (INV-7).</summary>
    [Fact]
    [ContractTest("INV-7")]
    public void Inv7_AnonymousMode_IsDeterministic()
    {
        var salt = Encoding.UTF8.GetBytes("bundle-salt-abc123");
        var pseudonymizer = new Pseudonymizer(PseudonymizationMode.Anonymous);
        const string path = @"C:\Users\john.doe\Documents";

        var first = pseudonymizer.Pseudonymize(path, salt);
        var second = pseudonymizer.Pseudonymize(path, salt);

        Assert.Equal(first, second);

        // Different salts must yield different pseudonyms
        var otherSalt = Encoding.UTF8.GetBytes("other-bundle-xyz");
        var different = pseudonymizer.Pseudonymize(path, otherSalt);
        Assert.NotEqual(first, different);
    }

    /// <summary>No source file in AiOrchestrator.Redaction contains <c>new Regex(</c> (INV-2).</summary>
    [Fact]
    [ContractTest("INV-2")]
    public void Inv2_NoNewRegexInSource()
    {
        // Walk up from the test binary to locate the repo root
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "src", "dotnet")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        var redactionSrc = Path.Combine(dir!.FullName, "src", "dotnet", "AiOrchestrator.Redaction");
        Assert.True(Directory.Exists(redactionSrc), "AiOrchestrator.Redaction source directory must exist");

        var violations = Directory
            .GetFiles(redactionSrc, "*.cs", SearchOption.AllDirectories)
            .Where(f => File.ReadAllText(f).Contains("new Regex(", StringComparison.Ordinal))
            .ToList();

        Assert.Empty(violations);
    }
}
