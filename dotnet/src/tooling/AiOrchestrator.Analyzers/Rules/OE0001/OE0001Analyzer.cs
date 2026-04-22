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
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0001);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.ClassDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.StructDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.InterfaceDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.EnumDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.DelegateDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.RecordDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeNode, SyntaxKind.RecordStructDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.MethodDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.PropertyDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.FieldDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.EventDeclaration);
        context.RegisterSyntaxNodeAction(AnalyzeMember, SyntaxKind.EventFieldDeclaration);
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
