// <copyright file="CompositionPlaceholder.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Composition;

/// <summary>
/// Placeholder class that ensures the Composition project compiles.
/// Subsequent jobs add partial extension methods named <c>CompositionRoot.Add&lt;X&gt;(this IServiceCollection)</c>.
/// </summary>
internal sealed class CompositionPlaceholder
{
}
