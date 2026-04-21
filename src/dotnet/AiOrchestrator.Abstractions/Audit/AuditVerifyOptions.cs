// <copyright file="AuditVerifyOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Audit;

/// <summary>Options controlling the scope of an audit chain verification.</summary>
/// <param name="FromSequence">The inclusive starting sequence number, or <see langword="null"/> to start from the beginning.</param>
/// <param name="ToSequence">The inclusive ending sequence number, or <see langword="null"/> to verify to the end.</param>
/// <param name="StopOnFirstError">Whether to stop immediately on the first chain integrity violation.</param>
public sealed record AuditVerifyOptions(
    long? FromSequence,
    long? ToSequence,
    bool StopOnFirstError);
