// <copyright file="IRedactor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;

namespace AiOrchestrator.Abstractions.Redaction;

/// <summary>
/// Redacts sensitive content (secrets, credentials, PII) from text and byte streams
/// according to the configured policy.
/// </summary>
public interface IRedactor
{
    /// <summary>Redacts sensitive substrings from a string in-process.</summary>
    /// <param name="input">The input text that may contain sensitive content.</param>
    /// <returns>The input with all matched sensitive content replaced.</returns>
    string Redact(string input);

    /// <summary>Streams a byte sequence through the redactor, writing the redacted output.</summary>
    /// <param name="input">The input byte sequence (typically a buffered chunk of stdout/stderr).</param>
    /// <param name="output">The destination buffer writer for the redacted output.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of bytes written to <paramref name="output"/>.</returns>
    ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct);
}
