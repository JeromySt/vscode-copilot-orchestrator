// <copyright file="OE0002Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
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
    private const string CliNamespace = "AiOrchestrator.Cli";
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
        // Determine if the call site is in a composition root (Composition or CLI).
        var containingNamespace = GetContainingNamespace(ctx.Node);
        if (containingNamespace != null &&
            (containingNamespace.StartsWith(CompositionNamespace, System.StringComparison.Ordinal) ||
             containingNamespace.StartsWith(CliNamespace, System.StringComparison.Ordinal)))
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

        // Value types (readonly record structs like PlanId, JobId, RunId, AbsolutePath) are never DI-managed.
        if (type.IsValueType)
        {
            return;
        }

        // Nested private types (e.g., JSON converters) are implementation details, not DI services.
        if (type is INamedTypeSymbol { DeclaredAccessibility: Accessibility.Private, ContainingType: not null })
        {
            return;
        }

        // Exception types are never DI-managed.
        if (InheritsFrom(type, "System.Exception"))
        {
            return;
        }

        // Record types are data carriers (DTOs, mutations, results), never DI services.
        if (type is INamedTypeSymbol { IsRecord: true })
        {
            return;
        }

        // Internal wiring: when a type is instantiated within its own assembly
        // (e.g., ProcessSpawner creates ProcessHandle), this is a factory / internal
        // pattern, not a cross-boundary DI violation.
        var callerAssembly = ctx.SemanticModel.Compilation.AssemblyName;
        var typeAssembly = type.ContainingAssembly?.Name;
        if (callerAssembly != null && callerAssembly == typeAssembly)
        {
            return;
        }

        // Types that don't implement any AiOrchestrator.* interface are not DI-managed services.
        if (!type.AllInterfaces.Any(i =>
                i.ContainingNamespace?.ToDisplayString()?.StartsWith(AiOrchestratorPrefix, System.StringComparison.Ordinal) == true))
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

    private static bool InheritsFrom(ITypeSymbol type, string baseTypeFullName)
    {
        var current = type.BaseType;
        while (current != null)
        {
            if (current.ToDisplayString() == baseTypeFullName)
            {
                return true;
            }

            current = current.BaseType;
        }

        return false;
    }
}
