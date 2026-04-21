// <copyright file="OE0006Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0006;

/// <summary>
/// OE0006 — Reports use of <c>LibGit2Sharp</c> (via namespace or type reference) outside
/// the <c>AiOrchestrator.Git</c> project.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0006GitOutsideGitProjectAnalyzer : DiagnosticAnalyzer
{
    private const string LibGit2SharpPrefix = "LibGit2Sharp";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0006);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeUsingDirective, SyntaxKind.UsingDirective);
        context.RegisterSyntaxNodeAction(AnalyzeIdentifier, SyntaxKind.IdentifierName);
    }

    private static void AnalyzeUsingDirective(SyntaxNodeAnalysisContext ctx)
    {
        var usingDirective = (UsingDirectiveSyntax)ctx.Node;
        var name = usingDirective.Name?.ToString() ?? string.Empty;

        if (!name.StartsWith(LibGit2SharpPrefix, System.StringComparison.Ordinal))
        {
            return;
        }

        if (!IsInGitProject(ctx.Node))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0006, usingDirective.GetLocation()));
        }
    }

    private static void AnalyzeIdentifier(SyntaxNodeAnalysisContext ctx)
    {
        var identifier = (IdentifierNameSyntax)ctx.Node;

        // Skip identifiers that are children of using directives (covered above).
        if (identifier.Parent is UsingDirectiveSyntax ||
            identifier.Parent is QualifiedNameSyntax qn && qn.Parent is UsingDirectiveSyntax)
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(identifier);
        var symbol = symbolInfo.Symbol;
        if (symbol is null)
        {
            return;
        }

        var ns = symbol.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        if (!ns.StartsWith(LibGit2SharpPrefix, System.StringComparison.Ordinal))
        {
            return;
        }

        if (!IsInGitProject(ctx.Node))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0006, identifier.GetLocation()));
        }
    }

    private static bool IsInGitProject(SyntaxNode node)
    {
        var filePath = node.SyntaxTree.FilePath ?? string.Empty;
        return filePath.Contains("AiOrchestrator.Git", System.StringComparison.OrdinalIgnoreCase);
    }
}
