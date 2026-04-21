// <copyright file="OE0002Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0002;

/// <summary>
/// OE0002 — Reports direct <c>new ConcreteService()</c> instantiation of any AiOrchestrator
/// type whose namespace indicates it should be DI-managed, when the call site is not inside
/// <c>AiOrchestrator.Composition</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0002Analyzer : DiagnosticAnalyzer
{
    private const string CompositionNamespace = "AiOrchestrator.Composition";
    private const string AiOrchestratorPrefix = "AiOrchestrator.";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0002);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeObjectCreation, SyntaxKind.ObjectCreationExpression);
        context.RegisterSyntaxNodeAction(AnalyzeObjectCreation, SyntaxKind.ImplicitObjectCreationExpression);
    }

    private static void AnalyzeObjectCreation(SyntaxNodeAnalysisContext ctx)
    {
        // Determine if the call site is in the Composition namespace.
        var containingNamespace = GetContainingNamespace(ctx.Node);
        if (containingNamespace != null &&
            containingNamespace.StartsWith(CompositionNamespace, System.StringComparison.Ordinal))
        {
            return;
        }

        // Resolve the constructed type.
        var typeInfo = ctx.SemanticModel.GetTypeInfo(ctx.Node);
        var type = typeInfo.Type;
        if (type is null)
        {
            return;
        }

        var fullNamespace = type.ContainingNamespace?.ToDisplayString();
        if (fullNamespace is null)
        {
            return;
        }

        // Flag if the type lives in an AiOrchestrator.* namespace other than Composition.
        if (fullNamespace.StartsWith(AiOrchestratorPrefix, System.StringComparison.Ordinal) &&
            !fullNamespace.StartsWith(CompositionNamespace, System.StringComparison.Ordinal))
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0002,
                ctx.Node.GetLocation(),
                type.Name));
        }
    }

    private static string? GetContainingNamespace(SyntaxNode node)
    {
        var ancestor = node.Parent;
        while (ancestor != null)
        {
            if (ancestor is NamespaceDeclarationSyntax ns)
            {
                return ns.Name.ToString();
            }

            if (ancestor is FileScopedNamespaceDeclarationSyntax fsns)
            {
                return fsns.Name.ToString();
            }

            ancestor = ancestor.Parent;
        }

        return null;
    }
}
