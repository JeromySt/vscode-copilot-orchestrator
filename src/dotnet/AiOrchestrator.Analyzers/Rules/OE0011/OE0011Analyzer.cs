// <copyright file="OE0011Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0011;

/// <summary>
/// OE0011 — Reports synchronous <c>System.IO.File</c> read/write methods:
/// <c>ReadAllText</c>, <c>WriteAllText</c>, <c>Open</c>, <c>OpenRead</c>, <c>OpenWrite</c>,
/// <c>ReadAllBytes</c>, <c>WriteAllBytes</c>, <c>ReadAllLines</c>, <c>WriteAllLines</c>,
/// <c>AppendAllText</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0011Analyzer : DiagnosticAnalyzer
{
    private static readonly ImmutableHashSet<string> BannedMethods = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "ReadAllText",
        "WriteAllText",
        "Open",
        "OpenRead",
        "OpenWrite",
        "ReadAllBytes",
        "WriteAllBytes",
        "ReadAllLines",
        "WriteAllLines",
        "AppendAllText");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0011);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeInvocation, SyntaxKind.InvocationExpression);
    }

    private static void AnalyzeInvocation(SyntaxNodeAnalysisContext ctx)
    {
        var invocation = (InvocationExpressionSyntax)ctx.Node;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
        {
            return;
        }

        var methodName = memberAccess.Name.Identifier.Text;
        if (!BannedMethods.Contains(methodName))
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(invocation);
        if (symbolInfo.Symbol is not IMethodSymbol method)
        {
            return;
        }

        if (method.ContainingType?.ToDisplayString() == "System.IO.File")
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0011,
                invocation.GetLocation(),
                $"System.IO.File.{methodName}"));
        }
    }
}
