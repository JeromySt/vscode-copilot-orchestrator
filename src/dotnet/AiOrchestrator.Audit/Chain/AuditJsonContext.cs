// <copyright file="AuditJsonContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text.Json.Serialization;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Audit.Chain;

/// <summary>Source-generated JSON serializer context for audit on-disk types.</summary>
[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(SegmentHeaderDto))]
[JsonSerializable(typeof(AuditRecordDto))]
internal sealed partial class AuditJsonContext : JsonSerializerContext
{
}

/// <summary>JSON-friendly DTO for <see cref="SegmentHeader"/>.</summary>
internal sealed record SegmentHeaderDto
{
    public Guid SegmentId { get; init; }

    public Guid? PrevSegmentId { get; init; }

    public byte[] PrevSegmentHmac { get; init; } = Array.Empty<byte>();

    public byte[] SignerPubKeyFingerprint { get; init; } = Array.Empty<byte>();

    public string SignerKeyId { get; init; } = string.Empty;

    public DateTimeOffset CreatedAt { get; init; }

    public long SegmentSeq { get; init; }

    public List<KeyTransitionRefDto> EffectiveTransitions { get; init; } = new();

    public static SegmentHeaderDto From(SegmentHeader h) => new()
    {
        SegmentId = h.SegmentId,
        PrevSegmentId = h.PrevSegmentId,
        PrevSegmentHmac = h.PrevSegmentHmac,
        SignerPubKeyFingerprint = h.SignerPubKeyFingerprint,
        SignerKeyId = h.SignerKeyId,
        CreatedAt = h.CreatedAt,
        SegmentSeq = h.SegmentSeq,
        EffectiveTransitions = h.EffectiveTransitions.Select(t => new KeyTransitionRefDto { OldKeyId = t.OldKeyId, NewKeyId = t.NewKeyId }).ToList(),
    };

    public SegmentHeader ToHeader() => new()
    {
        SegmentId = this.SegmentId,
        PrevSegmentId = this.PrevSegmentId,
        PrevSegmentHmac = this.PrevSegmentHmac,
        SignerPubKeyFingerprint = this.SignerPubKeyFingerprint,
        SignerKeyId = this.SignerKeyId,
        CreatedAt = this.CreatedAt,
        SegmentSeq = this.SegmentSeq,
        EffectiveTransitions = this.EffectiveTransitions.Select(t => new KeyTransitionRef(t.OldKeyId, t.NewKeyId)).ToImmutableArray(),
    };
}

internal sealed record KeyTransitionRefDto
{
    public string OldKeyId { get; init; } = string.Empty;

    public string NewKeyId { get; init; } = string.Empty;
}

/// <summary>JSON-friendly DTO for <see cref="AuditRecord"/>.</summary>
internal sealed record AuditRecordDto
{
    public string EventType { get; init; } = string.Empty;

    public DateTimeOffset At { get; init; }

    public AuthContextDto Principal { get; init; } = new();

    public string ContentJson { get; init; } = string.Empty;

    public List<string> ResourceRefs { get; init; } = new();

    public static AuditRecordDto From(AuditRecord r) => new()
    {
        EventType = r.EventType,
        At = r.At,
        Principal = AuthContextDto.From(r.Principal),
        ContentJson = r.ContentJson,
        ResourceRefs = r.ResourceRefs.ToList(),
    };

    public AuditRecord ToRecord() => new()
    {
        EventType = this.EventType,
        At = this.At,
        Principal = this.Principal.ToAuthContext(),
        ContentJson = this.ContentJson,
        ResourceRefs = this.ResourceRefs.ToImmutableArray(),
    };
}

internal sealed record AuthContextDto
{
    public string PrincipalId { get; init; } = string.Empty;

    public string DisplayName { get; init; } = string.Empty;

    public List<string> Scopes { get; init; } = new();

    public DateTimeOffset IssuedAtUtc { get; init; }

    public DateTimeOffset? ExpiresAtUtc { get; init; }

    public static AuthContextDto From(AuthContext a) => new()
    {
        PrincipalId = a.PrincipalId,
        DisplayName = a.DisplayName,
        Scopes = a.Scopes.ToList(),
        IssuedAtUtc = a.IssuedAtUtc,
        ExpiresAtUtc = a.ExpiresAtUtc,
    };

    public AuthContext ToAuthContext() => new()
    {
        PrincipalId = this.PrincipalId,
        DisplayName = this.DisplayName,
        Scopes = this.Scopes.ToImmutableArray(),
        IssuedAtUtc = this.IssuedAtUtc,
        ExpiresAtUtc = this.ExpiresAtUtc,
    };
}
