// <copyright file="OE0030CodeFix.cs" company="AiOrchestrator contributors">
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

namespace AiOrchestrator.Analyzers.Rules.OE0030;

/// <summary>
/// Code fix for OE0030 — adds <c>[ContractTest("TODO")]</c> to a test method that is missing it.
/// </summary>
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(OE0030CodeFix))]
[System.Composition.Shared]
public sealed class OE0030CodeFix : CodeFixProvider
{
    /// <inheritdoc/>
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.OE0030);

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
                title: "Add [ContractTest(\"TODO\")] attribute",
                createChangedDocument: ct => AddContractTestAttributeAsync(context.Document, method, ct),
                equivalenceKey: DiagnosticIds.OE0030),
            diagnostic);
    }

    private static async Task<Document> AddContractTestAttributeAsync(
        Document document,
        MethodDeclarationSyntax method,
        CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        var attributeName = SyntaxFactory.ParseName("ContractTest");
        var argument = SyntaxFactory.AttributeArgument(
            SyntaxFactory.LiteralExpression(
                SyntaxKind.StringLiteralExpression,
                SyntaxFactory.Literal("TODO")));
        var argumentList = SyntaxFactory.AttributeArgumentList(
            SyntaxFactory.SeparatedList(new[] { argument }));
        var attribute = SyntaxFactory.Attribute(attributeName, argumentList);
        var attributeList = SyntaxFactory.AttributeList(
            SyntaxFactory.SeparatedList(new[] { attribute }))
            .WithTrailingTrivia(SyntaxFactory.ElasticCarriageReturnLineFeed);

        var newMethod = method.WithAttributeLists(
            method.AttributeLists.Add(attributeList));

        var newRoot = root.ReplaceNode(method, newMethod);
        return document.WithSyntaxRoot(newRoot);
    }
}
