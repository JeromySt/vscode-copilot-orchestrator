// <copyright file="OE0009CodeFix.cs" company="AiOrchestrator contributors">
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

namespace AiOrchestrator.Analyzers.Rules.OE0009;

/// <summary>
/// Code fix for OE0009 — replaces <c>[DllImport("lib")]</c> with <c>[LibraryImport("lib")]</c>.
/// </summary>
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(OE0009CodeFix))]
[System.Composition.Shared]
public sealed class OE0009CodeFix : CodeFixProvider
{
    /// <inheritdoc/>
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.OE0009);

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
        var attribute = token.Parent?.AncestorsAndSelf().OfType<AttributeSyntax>().FirstOrDefault();
        if (attribute is null)
        {
            return;
        }

        context.RegisterCodeFix(
            CodeAction.Create(
                title: "Replace [DllImport] with [LibraryImport]",
                createChangedDocument: ct => ReplaceWithLibraryImportAsync(context.Document, attribute, ct),
                equivalenceKey: DiagnosticIds.OE0009),
            diagnostic);
    }

    private static async Task<Document> ReplaceWithLibraryImportAsync(
        Document document,
        AttributeSyntax dllImportAttr,
        CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        var libraryImportName = SyntaxFactory.ParseName("System.Runtime.InteropServices.LibraryImport");
        var newAttr = dllImportAttr.WithName(libraryImportName)
            .WithLeadingTrivia(dllImportAttr.GetLeadingTrivia())
            .WithTrailingTrivia(dllImportAttr.GetTrailingTrivia());

        var newRoot = root.ReplaceNode(dllImportAttr, newAttr);
        return document.WithSyntaxRoot(newRoot);
    }
}
