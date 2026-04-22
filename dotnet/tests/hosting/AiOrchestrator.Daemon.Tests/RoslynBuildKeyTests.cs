// <copyright file="RoslynBuildKeyTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class RoslynBuildKeyTests
{
    [Fact]
    [ContractTest("TRUST-ROOT-4-DAEMON")]
    public void DAEMON_NEVER_SIGNS_WithBuildKey()
    {
        var asmPath = Path.Combine(AppContext.BaseDirectory, "AiOrchestrator.Daemon.dll");
        Assert.True(File.Exists(asmPath), $"daemon assembly not co-located: {asmPath}");

        var violations = new System.Collections.Generic.List<string>();
        using var fs = File.OpenRead(asmPath);
        using var pe = new PEReader(fs);
        var md = pe.GetMetadataReader();

        foreach (var handle in md.MemberReferences)
        {
            var mref = md.GetMemberReference(handle);
            var name = md.GetString(mref.Name);
            if (!string.Equals(name, "Sign", StringComparison.Ordinal))
            {
                continue;
            }

            if (mref.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var tref = md.GetTypeReference((TypeReferenceHandle)mref.Parent);
            var typeName = md.GetString(tref.Name);
            var typeNs = md.GetString(tref.Namespace);
            if (string.Equals(typeName, "EcdsaSigner", StringComparison.Ordinal)
                && string.Equals(typeNs, "AiOrchestrator.Audit.Crypto", StringComparison.Ordinal))
            {
                violations.Add($"{typeNs}.{typeName}.{name}");
            }
        }

        Assert.Empty(violations);
    }
}
