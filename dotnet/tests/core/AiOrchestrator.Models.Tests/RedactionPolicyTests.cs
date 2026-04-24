// <copyright file="RedactionPolicyTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Redaction;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class RedactionPolicyTests
{
    [Fact]
    public void Construction_SetsProperties()
    {
        var policy = new RedactionPolicy
        {
            EnabledRules = ImmutableArray.Create("RULE-1", "RULE-2"),
            PseudonymizationMode = PseudonymizationMode.Anonymous,
        };

        Assert.Equal(2, policy.EnabledRules.Length);
        Assert.Equal(PseudonymizationMode.Anonymous, policy.PseudonymizationMode);
    }

    [Fact]
    public void Record_Equality_Works()
    {
        var rules = ImmutableArray.Create("RULE-1");
        var a = new RedactionPolicy { EnabledRules = rules, PseudonymizationMode = PseudonymizationMode.Off };
        var b = new RedactionPolicy { EnabledRules = rules, PseudonymizationMode = PseudonymizationMode.Off };

        Assert.Equal(a, b);
    }
}
