// <copyright file="OE0046Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0046;

/// <summary>
/// OE0046 — Reports logger calls where the first string argument uses C# string interpolation.
/// Interpolation defeats structured logging; use named message template placeholders instead.
/// Detects calls to <c>ILogger</c> extension methods (Log*, with a string-interpolation argument).
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0046LoggerStringInterpolationAnalyzer : DiagnosticAnalyzer
{
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0046);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeInvocation, SyntaxKind.InvocationExpression);
    }

    private static void AnalyzeInvocation(SyntaxNodeAnalysisContext ctx)
    {
        var invocation = (InvocationExpressionSyntax)ctx.Node;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
        {
            return;
        }

        var methodName = memberAccess.Name.Identifier.Text;

        // Look for Log*/logXxx methods that are logger-related.
        if (!IsLoggerMethod(methodName))
        {
            return;
        }

        // Find the first string argument.
        var args = invocation.ArgumentList.Arguments;
        if (args.Count == 0)
        {
            return;
        }

        // Check each argument for string interpolation.
        foreach (var arg in args)
        {
            if (arg.Expression is InterpolatedStringExpressionSyntax)
            {
                ctx.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.OE0046,
                    arg.GetLocation(),
                    methodName));
                return; // One diagnostic per call site is enough.
            }
        }
    }

    private static bool IsLoggerMethod(string methodName)
    {
        return methodName.StartsWith("Log", System.StringComparison.Ordinal) ||
               methodName is "LogInformation" or "LogWarning" or "LogError" or "LogDebug" or
               "LogTrace" or "LogCritical";
    }
}
