// <copyright file="OE0044_OnlyVsCodeTransportCanReferenceVsPackages.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers;

/// <summary>
/// OE0044 — enforces INV-1 of job 040: only <c>AiOrchestrator.VsCode.Transport</c>
/// may consume APIs from the <c>Microsoft.VisualStudio.*</c> package family. Any other
/// .NET project that resolves a type from this namespace surfaces an error.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0044_OnlyVsCodeTransportCanReferenceVsPackages : DiagnosticAnalyzer
{
    /// <summary>The diagnostic id used in build output and suppression files.</summary>
    public const string DiagnosticId = "OE0044";

    private const string AllowedAssemblyName = "AiOrchestrator.VsCode.Transport";
    private const string ForbiddenNamespacePrefix = "Microsoft.VisualStudio.";

    private static readonly DiagnosticDescriptor Rule = new(
        id: DiagnosticId,
        title: "Only AiOrchestrator.VsCode.Transport may reference Microsoft.VisualStudio.* packages",
        messageFormat: "Type '{0}' is in the 'Microsoft.VisualStudio.*' namespace family, which is only allowed from the 'AiOrchestrator.VsCode.Transport' project (job 040 INV-1).",
        category: "AiOrchestrator.Architecture",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Job 040 (§4.6) designates AiOrchestrator.VsCode.Transport as the sole boundary between the .NET orchestrator and the VS Code SDK. Every other project must go through that transport.");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } = ImmutableArray.Create(Rule);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        if (context is null)
        {
            return;
        }

        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterCompilationStartAction(OnCompilationStart);
    }

    private static void OnCompilationStart(CompilationStartAnalysisContext context)
    {
        string? assemblyName = context.Compilation.AssemblyName;
        if (string.Equals(assemblyName, AllowedAssemblyName, System.StringComparison.Ordinal))
        {
            // INV-1 exemption: this is the only assembly permitted to consume VS SDK packages.
            return;
        }

        context.RegisterSyntaxNodeAction(AnalyzeNameSyntax, Microsoft.CodeAnalysis.CSharp.SyntaxKind.QualifiedName,
            Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierName,
            Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleMemberAccessExpression);
    }

    private static void AnalyzeNameSyntax(SyntaxNodeAnalysisContext context)
    {
        SymbolInfo info = context.SemanticModel.GetSymbolInfo(context.Node, context.CancellationToken);
        ISymbol? symbol = info.Symbol ?? (info.CandidateSymbols.Length > 0 ? info.CandidateSymbols[0] : null);
        if (symbol is null)
        {
            return;
        }

        INamespaceSymbol? ns = symbol switch
        {
            INamespaceSymbol n => n,
            ITypeSymbol t => t.ContainingNamespace,
            _ => symbol.ContainingNamespace,
        };

        if (ns is null)
        {
            return;
        }

        string fullName = ns.ToDisplayString();
        if (fullName.StartsWith(ForbiddenNamespacePrefix, System.StringComparison.Ordinal))
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation(), symbol.ToDisplayString()));
        }
    }
}
