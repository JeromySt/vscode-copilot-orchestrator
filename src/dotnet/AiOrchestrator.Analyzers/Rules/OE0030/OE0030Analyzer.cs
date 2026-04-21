// <copyright file="OE0030Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0030;

/// <summary>
/// OE0030 — Reports test methods (decorated with <c>[Fact]</c> or <c>[Theory]</c>) that do
/// not carry a <c>[ContractTest("RULE-ID")]</c> attribute.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0030TestMissingContractTestAttributeAnalyzer : DiagnosticAnalyzer
{
    private const string FactAttribute = "Fact";
    private const string TheoryAttribute = "Theory";
    private const string ContractTestAttribute = "ContractTest";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0030);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeMethod, SyntaxKind.MethodDeclaration);
    }

    private static void AnalyzeMethod(SyntaxNodeAnalysisContext ctx)
    {
        var method = (MethodDeclarationSyntax)ctx.Node;

        var allAttributes = method.AttributeLists.SelectMany(al => al.Attributes).ToList();

        bool isTestMethod = allAttributes.Any(a =>
        {
            var name = a.Name.ToString();
            return name == FactAttribute || name.EndsWith("." + FactAttribute, System.StringComparison.Ordinal) ||
                   name == TheoryAttribute || name.EndsWith("." + TheoryAttribute, System.StringComparison.Ordinal);
        });

        if (!isTestMethod)
        {
            return;
        }

        bool hasContractTest = allAttributes.Any(a =>
        {
            var name = a.Name.ToString();
            return name == ContractTestAttribute ||
                   name.EndsWith("." + ContractTestAttribute, System.StringComparison.Ordinal);
        });

        if (!hasContractTest)
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0030,
                method.Identifier.GetLocation(),
                method.Identifier.Text));
        }
    }
}
