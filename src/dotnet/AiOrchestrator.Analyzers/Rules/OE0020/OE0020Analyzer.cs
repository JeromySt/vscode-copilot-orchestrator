// <copyright file="OE0020Analyzer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace AiOrchestrator.Analyzers.Rules.OE0020;

/// <summary>
/// OE0020 — Reports any public method that has a parameter typed as <c>dynamic</c>
/// or <c>object</c>. Use a specific type or a generic parameter instead.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OE0020DynamicOrObjectParameterAnalyzer : DiagnosticAnalyzer
{
    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Diagnostics.OE0020);

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

        var symbol = ctx.SemanticModel.GetDeclaredSymbol(method);
        if (symbol is null || symbol.DeclaredAccessibility != Accessibility.Public)
        {
            return;
        }

        foreach (var parameter in method.ParameterList.Parameters)
        {
            if (parameter.Type is null)
            {
                continue;
            }

            var typeInfo = ctx.SemanticModel.GetTypeInfo(parameter.Type);
            var paramType = typeInfo.Type;
            if (paramType is null)
            {
                continue;
            }

            bool isDynamic = parameter.Type is IdentifierNameSyntax id &&
                             id.IsVar;
            bool isObjectType = paramType.SpecialType == SpecialType.System_Object;
            bool isDynamicType = paramType.TypeKind == TypeKind.Dynamic;

            if (isObjectType || isDynamicType || isDynamic)
            {
                var typeName = isDynamicType ? "dynamic" : "object";
                ctx.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.OE0020,
                    parameter.GetLocation(),
                    method.Identifier.Text,
                    parameter.Identifier.Text,
                    typeName));
            }
        }
    }
}
