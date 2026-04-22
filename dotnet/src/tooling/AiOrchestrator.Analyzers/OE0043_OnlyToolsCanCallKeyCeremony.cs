// <copyright file="OE0043_OnlyToolsCanCallKeyCeremony.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers
{
#pragma warning disable CA1707 // Type name contains underscores — follows OEnnnn_RuleName convention for analyzer types
#pragma warning disable CA1308 // ToLowerInvariant is intentional for path normalization

    /// <summary>
    /// OE0043: KeyCeremonyToolingStub may only be referenced from files under
    /// <c>tools/key-ceremony/</c> or <c>tests/</c>. The daemon must never sign
    /// with an HSM key (INV-10 of job 039).
    /// </summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class OE0043_OnlyToolsCanCallKeyCeremony : DiagnosticAnalyzer
    {
        public const string DiagnosticId = "OE0043";

        private static readonly DiagnosticDescriptor Rule = new(
            id: DiagnosticId,
            title: "KeyCeremonyToolingStub may only be referenced from tools/key-ceremony or tests",
            messageFormat: "Type 'KeyCeremonyToolingStub' may only be referenced from 'tools/key-ceremony/' or 'tests/' files",
            category: "Security",
            defaultSeverity: DiagnosticSeverity.Error,
            isEnabledByDefault: true,
            description: "The daemon path must never invoke key-ceremony tooling (INV-10).");

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
            ImmutableArray.Create(Rule);

        public override void Initialize(AnalysisContext context)
        {
            if (context is null)
            {
                return;
            }

            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSyntaxNodeAction(AnalyzeIdentifier, SyntaxKind.IdentifierName);
        }

        private static void AnalyzeIdentifier(SyntaxNodeAnalysisContext context)
        {
            var id = (IdentifierNameSyntax)context.Node;
            if (id.Identifier.ValueText != "KeyCeremonyToolingStub")
            {
                return;
            }

            var path = context.Node.SyntaxTree.FilePath ?? string.Empty;
            var normalized = path.Replace('\\', '/').ToLowerInvariant();
            if (normalized.Contains("tools/key-ceremony/") || normalized.Contains("/tests/") || normalized.Contains("tests/dotnet/"))
            {
                return;
            }

            var symbol = context.SemanticModel.GetSymbolInfo(id, context.CancellationToken).Symbol;
            if (symbol is null)
            {
                return;
            }

            var ns = symbol.ContainingNamespace?.ToDisplayString() ?? string.Empty;
            if (!ns.StartsWith("AiOrchestrator.SkewManifest.Tools", System.StringComparison.Ordinal))
            {
                return;
            }

            context.ReportDiagnostic(Diagnostic.Create(Rule, id.GetLocation()));
        }
    }
}
