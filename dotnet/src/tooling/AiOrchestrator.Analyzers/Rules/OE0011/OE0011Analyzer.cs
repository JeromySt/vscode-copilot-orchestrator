// <copyright file="OE0011Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0011;

/// <summary>
/// OE0011 — Reports synchronous <c>System.IO.File</c> read/write methods:
/// <c>ReadAllText</c>, <c>WriteAllText</c>, <c>Open</c>, <c>OpenRead</c>, <c>OpenWrite</c>,
/// <c>ReadAllBytes</c>, <c>WriteAllBytes</c>, <c>ReadAllLines</c>, <c>WriteAllLines</c>,
/// <c>AppendAllText</c>.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0011Analyzer : DiagnosticAnalyzer
{
    /// <summary>
    /// Assemblies that implement or directly support <c>IFileSystem</c> and therefore
    /// must use synchronous <c>System.IO.File</c> methods directly.
    /// </summary>
    private static readonly ImmutableHashSet<string> ExemptAssemblies = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "AiOrchestrator.Audit",
        "AiOrchestrator.Plan.Store",
        "AiOrchestrator.Process",
        "AiOrchestrator.EventLog",
        "AiOrchestrator.Git",
        "AiOrchestrator.WorktreeLease",
        "AiOrchestrator.Cli",
        "AiOrchestrator.Logging",
        "AiOrchestrator.FileSystem",
        "AiOrchestrator.HookGate",
        "AiOrchestrator.Daemon",
        "AiOrchestrator.Plugins",
        "AiOrchestrator.Concurrency.Broker",
        "AiOrchestrator.Diagnose",
        "AiOrchestrator.Plan.Portability",
        "AiOrchestrator.Credentials",
        "AiOrchestrator.Tools.KeyCeremony",
        "AiOrchestrator.Agent",
        "AiOrchestrator.Shell");

    private static readonly ImmutableHashSet<string> BannedMethods = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "ReadAllText",
        "WriteAllText",
        "Open",
        "OpenRead",
        "OpenWrite",
        "ReadAllBytes",
        "WriteAllBytes",
        "ReadAllLines",
        "WriteAllLines",
        "AppendAllText");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0011);

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

            compilationContext.RegisterSyntaxNodeAction(AnalyzeInvocation, SyntaxKind.InvocationExpression);
        });
    }

    private static void AnalyzeInvocation(SyntaxNodeAnalysisContext ctx)
    {
        var invocation = (InvocationExpressionSyntax)ctx.Node;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
        {
            return;
        }

        var methodName = memberAccess.Name.Identifier.Text;
        if (!BannedMethods.Contains(methodName))
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(invocation);
        if (symbolInfo.Symbol is not IMethodSymbol method)
        {
            return;
        }

        if (method.ContainingType?.ToDisplayString() == "System.IO.File")
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0011,
                invocation.GetLocation(),
                $"System.IO.File.{methodName}"));
        }
    }
}
