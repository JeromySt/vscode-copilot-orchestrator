// <copyright file="OE0001Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0001;

/// <summary>
/// OE0001 — Reports public types and members that lack an XML documentation comment.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0001Analyzer : DiagnosticAnalyzer
{
    /// <summary>
    /// Assemblies still in active development that are temporarily exempt from XML doc enforcement.
    /// </summary>
    private static readonly ImmutableHashSet<string> ExemptAssemblies = ImmutableHashSet.Create(
        System.StringComparer.Ordinal,
        "AiOrchestrator.HookGate",
        "AiOrchestrator.Daemon",
        "AiOrchestrator.SkewManifest",
        "AiOrchestrator.Diagnose",
        "AiOrchestrator.Concurrency.Broker",
        "AiOrchestrator.Plugins",
        "AiOrchestrator.Plan.Portability",
        "AiOrchestrator.Credentials",
        "AiOrchestrator.Tools.KeyCeremony",
        "AiOrchestrator.Agent",
        "AiOrchestrator.Eventing.Generators.SampleConsumer",
        "AiOrchestrator.Plan.Scheduler",
        "AiOrchestrator.Shell");

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0001);

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

            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.ClassDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.StructDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.InterfaceDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.EnumDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.DelegateDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.RecordDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.RecordStructDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.MethodDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.PropertyDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.FieldDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.EventDeclaration);
            compilationContext.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.EventFieldDeclaration);
        });
    }

    private static void AnalyzeNode(SyntaxNodeAnalysisContext ctx)
    {
        var node = ctx.Node;
        if (!IsPublicDeclaration(node, ctx.SemanticModel))
        {
            return;
        }

        if (!HasXmlDocComment(node))
        {
            var kind = GetKindName(node.Kind());
            var name = GetDeclarationName(node);
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0001, node.GetLocation(), kind, name));
        }
    }

    private static void AnalyzeMember(SyntaxNodeAnalysisContext ctx)
    {
        var node = ctx.Node;
        if (!IsPublicDeclaration(node, ctx.SemanticModel))
        {
            return;
        }

        if (!HasXmlDocComment(node))
        {
            var kind = GetKindName(node.Kind());
            var name = GetDeclarationName(node);
            ctx.ReportDiagnostic(Diagnostic.Create(Diagnostics.OE0001, node.GetLocation(), kind, name));
        }
    }

    private static bool IsPublicDeclaration(SyntaxNode node, SemanticModel model)
    {
        var symbol = model.GetDeclaredSymbol(node);
        if (symbol is null)
        {
            return false;
        }

        return symbol.DeclaredAccessibility == Accessibility.Public;
    }

    private static bool HasXmlDocComment(SyntaxNode node)
    {
        var trivia = node.GetLeadingTrivia();
        foreach (var t in trivia)
        {
            if (t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            {
                return true;
            }
        }

        return false;
    }

    private static string GetKindName(SyntaxKind kind)
    {
        return kind switch
        {
            SyntaxKind.ClassDeclaration => "class",
            SyntaxKind.StructDeclaration => "struct",
            SyntaxKind.InterfaceDeclaration => "interface",
            SyntaxKind.EnumDeclaration => "enum",
            SyntaxKind.DelegateDeclaration => "delegate",
            SyntaxKind.RecordDeclaration => "record",
            SyntaxKind.RecordStructDeclaration => "record struct",
            SyntaxKind.MethodDeclaration => "method",
            SyntaxKind.PropertyDeclaration => "property",
            SyntaxKind.FieldDeclaration => "field",
            SyntaxKind.EventDeclaration => "event",
            SyntaxKind.EventFieldDeclaration => "event",
            _ => "member",
        };
    }

    private static string GetDeclarationName(SyntaxNode node)
    {
        return node switch
        {
            BaseTypeDeclarationSyntax t => t.Identifier.Text,
            DelegateDeclarationSyntax d => d.Identifier.Text,
            MethodDeclarationSyntax m => m.Identifier.Text,
            PropertyDeclarationSyntax p => p.Identifier.Text,
            FieldDeclarationSyntax f => f.Declaration.Variables.FirstOrDefault()?.Identifier.Text ?? "?",
            EventDeclarationSyntax e => e.Identifier.Text,
            EventFieldDeclarationSyntax ef => ef.Declaration.Variables.FirstOrDefault()?.Identifier.Text ?? "?",
            _ => node.ToString(),
        };
    }
}
