// <copyright file="OE0007CodeFix.cs" company="AiOrchestrator contributors">
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

namespace AiOrchestrator.Analyzers.Rules.OE0007;

/// <summary>
/// Code fix for OE0007 — adds a <c>CancellationToken cancellationToken = default</c> parameter
/// to the end of the method parameter list.
/// </summary>
[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(OE0007CodeFix))]
[System.Composition.Shared]
public sealed class OE0007CodeFix : CodeFixProvider
{
    /// <inheritdoc/>
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.OE0007);

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
        var diagnosticSpan = diagnostic.Location.SourceSpan;
        var token = root.FindToken(diagnosticSpan.Start);
        var method = token.Parent?.AncestorsAndSelf().OfType<MethodDeclarationSyntax>().FirstOrDefault();
        if (method is null)
        {
            return;
        }

        context.RegisterCodeFix(
            CodeAction.Create(
                title: "Add CancellationToken parameter",
                createChangedDocument: ct => AddCancellationTokenAsync(context.Document, method, ct),
                equivalenceKey: DiagnosticIds.OE0007),
            diagnostic);
    }

    private static async Task<Document> AddCancellationTokenAsync(
        Document document,
        MethodDeclarationSyntax method,
        CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        // Build: CancellationToken cancellationToken = default
        var ctType = SyntaxFactory.ParseTypeName("System.Threading.CancellationToken")
            .WithLeadingTrivia(SyntaxFactory.Space);
        var ctParam = SyntaxFactory.Parameter(
                SyntaxFactory.Identifier("cancellationToken"))
            .WithType(ctType)
            .WithDefault(SyntaxFactory.EqualsValueClause(
                SyntaxFactory.LiteralExpression(SyntaxKind.DefaultLiteralExpression)));

        ParameterListSyntax newParamList;
        if (method.ParameterList.Parameters.Count == 0)
        {
            newParamList = method.ParameterList.AddParameters(ctParam);
        }
        else
        {
            var lastParam = method.ParameterList.Parameters.Last();
            var trailComma = SyntaxFactory.Token(SyntaxKind.CommaToken)
                .WithTrailingTrivia(SyntaxFactory.Space);
            var newParams = method.ParameterList.Parameters
                .Replace(lastParam, lastParam.WithoutTrailingTrivia())
                .Add(ctParam);
            newParamList = method.ParameterList.WithParameters(newParams)
                .WithAdditionalAnnotations();
            _ = trailComma; // The separator list is rebuilt internally.
            newParamList = method.ParameterList.AddParameters(ctParam);
        }

        var newMethod = method.WithParameterList(newParamList);
        var newRoot = root.ReplaceNode(method, newMethod);
        return document.WithSyntaxRoot(newRoot);
    }
}
