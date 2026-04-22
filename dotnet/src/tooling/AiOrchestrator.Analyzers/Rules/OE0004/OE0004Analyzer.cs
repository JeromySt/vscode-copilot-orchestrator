// <copyright file="OE0004Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0004;

/// <summary>
/// OE0004 — Reports any use of <c>System.IO.File</c> or <c>System.IO.Directory</c> outside
/// the <c>AiOrchestrator.FileSystem</c> project (identified by file path or namespace).
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0004Analyzer : DiagnosticAnalyzer
{
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0004);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeMemberAccess, SyntaxKind.SimpleMemberAccessExpression);
    }

    private static void AnalyzeMemberAccess(SyntaxNodeAnalysisContext ctx)
    {
        var memberAccess = (MemberAccessExpressionSyntax)ctx.Node;

        // Only look at the leftmost expression to avoid false positives on chained calls.
        if (memberAccess.Expression is MemberAccessExpressionSyntax)
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(memberAccess.Expression);
        if (symbolInfo.Symbol is null)
        {
            return;
        }

        var containingType = GetContainingType(symbolInfo.Symbol);
        if (containingType is null)
        {
            return;
        }

        var fullName = containingType.ToDisplayString();
        if (fullName != "System.IO.File" && fullName != "System.IO.Directory")
        {
            return;
        }

        if (IsInFileSystemProject(ctx.Node))
        {
            return;
        }

        ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0004, memberAccess.GetLocation(), fullName));
    }

    private static ITypeSymbol? GetContainingType(ISymbol symbol)
    {
        return symbol switch
        {
            ITypeSymbol t => t,
            IMethodSymbol m => m.ContainingType,
            IPropertySymbol p => p.ContainingType,
            IFieldSymbol f => f.ContainingType,
            _ => null,
        };
    }

    private static bool IsInFileSystemProject(SyntaxNode node)
    {
        var filePath = node.SyntaxTree.FilePath ?? string.Empty;
        return filePath.IndexOf("AiOrchestrator.FileSystem", System.StringComparison.OrdinalIgnoreCase) >= 0 ||
               filePath.IndexOf("FileSystem", System.StringComparison.OrdinalIgnoreCase) >= 0;
    }
}
