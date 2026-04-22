// <copyright file="OE0009Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0009;

/// <summary>
/// OE0009 — Reports methods decorated with <c>[DllImport]</c>. Use <c>[LibraryImport]</c>
/// for source-generated P/Invoke marshalling.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0009Analyzer : DiagnosticAnalyzer
{
    private const string DllImportShortName = "DllImport";
    private const string DllImportFullName = "DllImportAttribute";

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0009);

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
        var dllImportAttr = method.AttributeLists
            .SelectMany(al => al.Attributes)
            .FirstOrDefault(a =>
            {
                var name = a.Name.ToString();
                return name == DllImportShortName || name == DllImportFullName ||
                       name.EndsWith("." + DllImportShortName, System.StringComparison.Ordinal);
            });

        if (dllImportAttr is null)
        {
            return;
        }

        ctx.ReportDiagnostic(Diagnostic.Create(
            Diagnostics.OE0009,
            dllImportAttr.GetLocation()));
    }
}
