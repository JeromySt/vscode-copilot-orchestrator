// <copyright file="OE0040Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0040;

/// <summary>
/// OE0040 — Reports calls to <c>JsonSerializer.Serialize</c> or <c>JsonSerializer.Deserialize</c>
/// that do not pass a <c>JsonSerializerContext</c> (source-generated) argument.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0040Analyzer : DiagnosticAnalyzer
{
    private const string JsonSerializerType = "System.Text.Json.JsonSerializer";

    /// <summary>
    /// Assemblies that define their own <c>JsonSerializerContext</c> or manage serialization
    /// internally and are exempt from the source-gen requirement.
    /// </summary>
    private static readonly ImmutableHashSet<string> ExemptAssemblies = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "AiOrchestrator.Audit",
        "AiOrchestrator.Plan.Store",
        "AiOrchestrator.WorktreeLease",
        "AiOrchestrator.Cli",
        "AiOrchestrator.EventLog",
        "AiOrchestrator.Logging",
        "AiOrchestrator.Diagnose",
        "AiOrchestrator.SkewManifest",
        "AiOrchestrator.Plugins",
        "AiOrchestrator.Daemon",
        "AiOrchestrator.Plan.Portability",
        "AiOrchestrator.Credentials",
        "AiOrchestrator.HookGate",
        "AiOrchestrator.Tools.KeyCeremony",
        "AiOrchestrator.Agent",
        "AiOrchestrator.Shell");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0040);

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
        if (methodName != "Serialize" && methodName != "Deserialize")
        {
            return;
        }

        var symbolInfo = ctx.SemanticModel.GetSymbolInfo(invocation);
        if (symbolInfo.Symbol is not IMethodSymbol method)
        {
            return;
        }

        if (method.ContainingType?.ToDisplayString() != JsonSerializerType)
        {
            return;
        }

        // Check whether any argument or the type's overload accepts JsonSerializerContext.
        bool hasContext = false;
        foreach (var param in method.Parameters)
        {
            var paramType = param.Type.ToDisplayString();
            if (paramType == "System.Text.Json.Serialization.JsonSerializerContext" ||
                paramType == "System.Text.Json.JsonSerializerOptions")
            {
                hasContext = true;
                break;
            }
        }

        if (!hasContext)
        {
            ctx.ReportDiagnostic(Diagnostic.Create(
                Diagnostics.OE0040,
                invocation.GetLocation(),
                $"JsonSerializer.{methodName}"));
        }
    }
}
