// <copyright file="OE0008Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0008;

/// <summary>
/// OE0008 — Reports <c>async void</c> methods. The only exception is methods that carry
/// <c>[AsyncEventHandler]</c> or that match the standard event-handler signature
/// (<c>(object sender, EventArgs e)</c>).
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0008AsyncVoidAnalyzer : DiagnosticAnalyzer
{
    private const string AsyncEventHandlerAttribute = "AsyncEventHandler";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0008);

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

        if (!method.Modifiers.Any(SyntaxKind.AsyncKeyword))
        {
            return;
        }

        if (!(method.ReturnType is PredefinedTypeSyntax pre &&
              pre.Keyword.IsKind(SyntaxKind.VoidKeyword)))
        {
            return;
        }

        // Exempt methods with [AsyncEventHandler] attribute.
        if (method.AttributeLists
            .SelectMany(al => al.Attributes)
            .Any(a => a.Name.ToString().Contains(AsyncEventHandlerAttribute, System.StringComparison.Ordinal)))
        {
            return;
        }

        // Exempt methods with classic event-handler signature: (object sender, EventArgs e).
        if (IsClassicEventHandlerSignature(method, ctx.SemanticModel))
        {
            return;
        }

        ctx.ReportDiagnostic(Diagnostic.Create(
            Diagnostics.OE0008,
            method.Identifier.GetLocation(),
            method.Identifier.Text));
    }

    private static bool IsClassicEventHandlerSignature(MethodDeclarationSyntax method, SemanticModel model)
    {
        var parameters = method.ParameterList.Parameters;
        if (parameters.Count != 2)
        {
            return false;
        }

        var p0 = model.GetDeclaredSymbol(parameters[0]);
        var p1 = model.GetDeclaredSymbol(parameters[1]);
        if (p0 is null || p1 is null)
        {
            return false;
        }

        return p0.Type.SpecialType == SpecialType.System_Object &&
               IsEventArgsType(p1.Type);
    }

    private static bool IsEventArgsType(ITypeSymbol type)
    {
        var t = type;
        while (t != null)
        {
            if (t.ToDisplayString() == "System.EventArgs")
            {
                return true;
            }

            t = t.BaseType!;
        }

        return false;
    }
}
