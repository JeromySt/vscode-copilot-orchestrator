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
/// the low-level infrastructure assemblies that <em>are</em> the filesystem abstraction layer.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0004Analyzer : DiagnosticAnalyzer
{
    /// <summary>
    /// Assemblies that implement or directly support <c>IFileSystem</c> and therefore
    /// must use <c>System.IO.File</c> / <c>System.IO.Directory</c> directly.
    /// </summary>
    private static readonly ImmutableHashSet<string> ExemptAssemblies = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "AiOrchestrator.FileSystem");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0004);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterCompilationStartAction(compilationContext =>
        {
            var assemblyName = compilationContext.Compilation.AssemblyName;
            if (assemblyName != null && ExemptAssemblies.Contains(assemblyName))
            {
                return;
            }

            compilationContext.RegisterSyntaxNodeAction(AnalyzeMemberAccess, SyntaxKind.SimpleMemberAccessExpression);
        });
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
}
