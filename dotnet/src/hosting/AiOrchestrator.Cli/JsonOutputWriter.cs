// <copyright file="JsonOutputWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli;

/// <summary>
/// Writes CLI results as JSON using only source-generated
/// <see cref="JsonTypeInfo{T}"/> metadata. No reflection-based
/// <c>JsonSerializer.Serialize&lt;T&gt;(value)</c> overload is permitted.
/// </summary>
internal sealed class JsonOutputWriter
{
    /// <summary>Serializes <paramref name="value"/> to <paramref name="writer"/> as indented JSON.</summary>
    /// <typeparam name="T">The value type.</typeparam>
    /// <param name="value">The value to serialize.</param>
    /// <param name="writer">The writer destination.</param>
    /// <param name="typeInfo">Source-generated metadata describing <typeparamref name="T"/>.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed <see cref="ValueTask"/>.</returns>
    public async ValueTask WriteAsync<T>(T value, TextWriter writer, JsonTypeInfo<T> typeInfo, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(typeInfo);

        string payload = JsonSerializer.Serialize(value, typeInfo);
        await writer.WriteLineAsync(payload.AsMemory(), ct).ConfigureAwait(false);
    }
}
