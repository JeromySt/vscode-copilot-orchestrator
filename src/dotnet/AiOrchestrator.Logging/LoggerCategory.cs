// <copyright file="LoggerCategory.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Logging;

/// <summary>
/// Provides a stable category name for logger instances, derived from the full name of
/// <typeparamref name="T"/>. Use with <c>ILogger&lt;T&gt;</c> or category-based log filtering.
/// </summary>
/// <typeparam name="T">The type whose full name is used as the log category.</typeparam>
public static class LoggerCategory<T>
{
    /// <summary>Gets the full name of <typeparamref name="T"/>, used as the logger category.</summary>
    public static readonly string Name = typeof(T).FullName!;
}
