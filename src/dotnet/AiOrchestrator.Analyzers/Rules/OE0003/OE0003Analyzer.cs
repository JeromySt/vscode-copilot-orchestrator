// <copyright file="OE0003Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0003;

/// <summary>
/// OE0003 — Reports usage of the <c>Microsoft.VisualStudio</c> namespace outside the VS extension
/// transport project. The extension transport project is identified by its root namespace containing
/// <c>VsExtension</c> or <c>Transport</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0003VsReferenceOutsideExtensionAnalyzer : DiagnosticAnalyzer
{
    private const string VsNamespacePrefix = "Microsoft.VisualStudio";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0003);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeUsingDirective, SyntaxKind.UsingDirective);
        context.RegisterSyntaxNodeAction(AnalyzeQualifiedName, SyntaxKind.QualifiedName);
    }

    private static void AnalyzeUsingDirective(SyntaxNodeAnalysisContext ctx)
    {
        var usingDirective = (UsingDirectiveSyntax)ctx.Node;
        var name = usingDirective.Name?.ToString() ?? string.Empty;

        if (!name.StartsWith(VsNamespacePrefix, System.StringComparison.Ordinal))
        {
            return;
        }

        if (IsInExtensionTransportProject(ctx.Node))
        {
            return;
        }

        ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0003, usingDirective.GetLocation()));
    }

    private static void AnalyzeQualifiedName(SyntaxNodeAnalysisContext ctx)
    {
        var qualifiedName = (QualifiedNameSyntax)ctx.Node;

        // Only flag top-level qualified names (e.g., the root of a member access).
        if (qualifiedName.Parent is QualifiedNameSyntax)
        {
            return;
        }

        var fullName = qualifiedName.ToString();
        if (!fullName.StartsWith(VsNamespacePrefix, System.StringComparison.Ordinal))
        {
            return;
        }

        if (IsInExtensionTransportProject(ctx.Node))
        {
            return;
        }

        // Only report for type-references (not for using directives, which are caught above).
        if (qualifiedName.Parent is UsingDirectiveSyntax)
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(qualifiedName);
        if (symbolInfo.Symbol is INamespaceSymbol || symbolInfo.Symbol is ITypeSymbol)
        {
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0003, qualifiedName.GetLocation()));
        }
    }

    private static bool IsInExtensionTransportProject(SyntaxNode node)
    {
        var filePath = node.SyntaxTree.FilePath ?? string.Empty;
        return filePath.Contains("VsExtension", System.StringComparison.OrdinalIgnoreCase) ||
               filePath.Contains("Transport", System.StringComparison.OrdinalIgnoreCase);
    }
}
