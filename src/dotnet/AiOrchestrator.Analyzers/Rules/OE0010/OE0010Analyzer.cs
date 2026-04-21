// <copyright file="OE0010Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0010;

/// <summary>
/// OE0010 — Reports use of banned time/threading APIs:
/// <c>DateTime.UtcNow</c>, <c>DateTime.Now</c>, <c>Environment.TickCount</c>,
/// and <c>Thread.Sleep</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0010Analyzer : DiagnosticAnalyzer
{
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0010);

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
        var memberName = memberAccess.Name.Identifier.Text;

        // Quick filter on member name before doing more expensive semantic analysis.
        if (memberName != "UtcNow" && memberName != "Now" &&
            memberName != "TickCount" && memberName != "Sleep")
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(memberAccess);
        var symbol = symbolInfo.Symbol;
        if (symbol is null)
        {
            return;
        }

        var containingType = symbol.ContainingType?.ToDisplayString();
        var fullName = containingType + "." + memberName;

        if (fullName == "System.DateTime.UtcNow" ||
            fullName == "System.DateTime.Now" ||
            fullName == "System.Environment.TickCount" ||
            fullName == "System.Environment.TickCount64" ||
            fullName == "System.Threading.Thread.Sleep")
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0010,
                memberAccess.GetLocation(),
                fullName));
        }
    }
}
