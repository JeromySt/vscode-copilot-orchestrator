// <copyright file="OE0008CodeFix.cs" company="AiOrchestrator contributors">
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

namespace AiOrchestrator.Analyzers.Rules.OE0008;

/// <summary>
/// Code fix for OE0008 — changes <c>async void</c> to <c>async Task</c>.
/// </summary>
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(OE0008CodeFix))]
[System.Composition.Shared]
public sealed class OE0008CodeFix : CodeFixProvider
{
    /// <inheritdoc/>
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.OE0008);

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
        var method = token.Parent?.AncestorsAndSelf().OfType<MethodDeclarationSyntax>().FirstOrDefault();
        if (method is null)
        {
            return;
        }

        context.RegisterCodeFix(
            CodeAction.Create(
                title: "Change return type to Task",
                createChangedDocument: ct => ChangeToTaskAsync(context.Document, method, ct),
                equivalenceKey: DiagnosticIds.OE0008),
            diagnostic);
    }

    private static async Task<Document> ChangeToTaskAsync(
        Document document,
        MethodDeclarationSyntax method,
        CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        var taskType = SyntaxFactory.ParseTypeName("System.Threading.Tasks.Task")
            .WithLeadingTrivia(method.ReturnType.GetLeadingTrivia())
            .WithTrailingTrivia(method.ReturnType.GetTrailingTrivia());

        var newMethod = method.WithReturnType(taskType);
        var newRoot = root.ReplaceNode(method, newMethod);
        return document.WithSyntaxRoot(newRoot);
    }
}
