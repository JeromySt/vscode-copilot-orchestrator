// <copyright file="OE0005Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0005;

/// <summary>
/// OE0005 — Reports any reference to <c>System.Diagnostics.Process</c> outside
/// the <c>AiOrchestrator.Process</c> project.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0005ProcessOutsideProcessProjectAnalyzer : DiagnosticAnalyzer
{
    private const string ProcessTypeName = "System.Diagnostics.Process";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0005);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeMemberAccess, SyntaxKind.SimpleMemberAccessExpression);
        context.RegisterSyntaxNodeAction(AnalyzeObjectCreation, SyntaxKind.ObjectCreationExpression);
    }

    private static void AnalyzeMemberAccess(SyntaxNodeAnalysisContext ctx)
    {
        var memberAccess = (MemberAccessExpressionSyntax)ctx.Node;
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
        if (containingType?.ToDisplayString() != ProcessTypeName)
        {
            return;
        }

        if (!IsInProcessProject(ctx.Node))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0005, memberAccess.GetLocation()));
        }
    }

    private static void AnalyzeObjectCreation(SyntaxNodeAnalysisContext ctx)
    {
        var typeInfo = ctx.SemanticModel.GetTypeInfo(ctx.Node);
        if (typeInfo.Type?.ToDisplayString() != ProcessTypeName)
        {
            return;
        }

        if (!IsInProcessProject(ctx.Node))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0005, ctx.Node.GetLocation()));
        }
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

    private static bool IsInProcessProject(SyntaxNode node)
    {
        var filePath = node.SyntaxTree.FilePath ?? string.Empty;
        return filePath.Contains("AiOrchestrator.Process", System.StringComparison.OrdinalIgnoreCase);
    }
}
