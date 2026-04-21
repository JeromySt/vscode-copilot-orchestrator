// <copyright file="OE0001CodeFix.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AiOrchestrator.Analyzers.Rules.OE0001;

/// <summary>
/// Code fix for OE0001 — inserts a minimal XML documentation comment template.
/// </summary>
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(OE0001AddXmlDocCodeFix))]
[System.Composition.Shared]
public sealed class OE0001AddXmlDocCodeFix : CodeFixProvider
{
    /// <inheritdoc/>
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.OE0001);

    /// <inheritdoc/>
    public override FixAllProvider GetFixAllProvider() =>
        WellKnownFixAllProviders.BatchFixer;

    /// <inheritdoc/>
    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return;
        }

        var diagnostic = context.Diagnostics.First();
        var token = root.FindToken(diagnostic.Location.SourceSpan.Start);
        var node = token.Parent?.AncestorsAndSelf()
            .FirstOrDefault(n => n is MemberDeclarationSyntax or BaseTypeDeclarationSyntax);

        if (node is null)
        {
            return;
        }

        context.RegisterCodeFix(
            CodeAction.Create(
                title: "Add XML documentation comment",
                createChangedDocument: ct => AddXmlDocAsync(context.Document, node, ct),
                equivalenceKey: DiagnosticIds.OE0001),
            diagnostic);
    }

    private static async Task<Document> AddXmlDocAsync(
        Document document,
        SyntaxNode node,
        CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        const string docTemplate = "/// <summary>\r\n/// TODO: Add documentation.\r\n/// </summary>\r\n";
        var docTrivia = SyntaxFactory.ParseLeadingTrivia(docTemplate);
        var existingLeading = node.GetLeadingTrivia();
        var newLeading = docTrivia.AddRange(existingLeading);
        var newNode = node.WithLeadingTrivia(newLeading);
        var newRoot = root.ReplaceNode(node, newNode);
        return document.WithSyntaxRoot(newRoot);
    }
}
