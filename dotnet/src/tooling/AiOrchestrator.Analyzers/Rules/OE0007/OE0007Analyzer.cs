// <copyright file="OE0007Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0007;

/// <summary>
/// OE0007 — Reports <c>async</c> methods that do not accept a <c>CancellationToken</c> parameter.
/// Entry-point methods (<c>Main</c>), event handlers, interface implementations where the
/// interface member lacks a token, and <c>async void</c> methods are exempt.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0007Analyzer : DiagnosticAnalyzer
{
    private const string CancellationTokenTypeName = "System.Threading.CancellationToken";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0007);

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

        // Only check async methods.
        if (!method.Modifiers.Any(SyntaxKind.AsyncKeyword))
        {
            return;
        }

        // Skip async void — covered by OE0008, and event handlers are intentionally void.
        if (method.ReturnType is PredefinedTypeSyntax pre &&
            pre.Keyword.IsKind(SyntaxKind.VoidKeyword))
        {
            return;
        }

        // Skip entry points.
        if (method.Identifier.Text == "Main")
        {
            return;
        }

        var symbol = (IMethodSymbol?)ctx.SemanticModel.GetDeclaredSymbol(method);
        if (symbol is null)
        {
            return;
        }

        // Skip interface implementations where the interface itself lacks a CancellationToken.
        foreach (var iface in symbol.ContainingType.AllInterfaces)
        {
            foreach (var member in iface.GetMembers())
            {
                if (symbol.ContainingType.FindImplementationForInterfaceMember(member) is IMethodSymbol impl &&
                    SymbolEqualityComparer.Default.Equals(impl, symbol))
                {
                    if (!ParameterHasCancellationToken(((IMethodSymbol)member).Parameters))
                    {
                        return;
                    }
                }
            }
        }

        // Check whether any parameter is a CancellationToken.
        if (!ParameterHasCancellationToken(symbol.Parameters))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0007,
                method.Identifier.GetLocation(),
                method.Identifier.Text));
        }
    }

    private static bool ParameterHasCancellationToken(ImmutableArray<IParameterSymbol> parameters)
    {
        foreach (var p in parameters)
        {
            if (p.Type.ToDisplayString() == CancellationTokenTypeName)
            {
                return true;
            }
        }

        return false;
    }
}
