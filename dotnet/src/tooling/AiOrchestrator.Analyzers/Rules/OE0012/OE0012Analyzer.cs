// <copyright file="OE0012Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0012;

/// <summary>
/// OE0012 — Reports any call to <c>System.Diagnostics.Process.Start</c>.
/// Use <c>IProcessSpawner</c> instead.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0012Analyzer : DiagnosticAnalyzer
{
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0012);

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

        if (memberAccess.Name.Identifier.Text != "Start")
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(invocation);
        if (symbolInfo.Symbol is not IMethodSymbol method)
        {
            return;
        }

        if (method.ContainingType?.ToDisplayString() == "System.Diagnostics.Process" &&
            method.Name == "Start")
        {
            if (IsInExemptProject(invocation))
            {
                return;
            }

            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0012, invocation.GetLocation()));
        }
    }

    private static bool IsInExemptProject(SyntaxNode node)
    {
        var filePath = node.SyntaxTree.FilePath ?? string.Empty;
        return filePath.IndexOf("AiOrchestrator.Process", System.StringComparison.OrdinalIgnoreCase) >= 0 ||
               filePath.IndexOf("AiOrchestrator.Git", System.StringComparison.OrdinalIgnoreCase) >= 0;
    }
}
