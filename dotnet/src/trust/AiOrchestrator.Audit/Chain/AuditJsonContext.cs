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
    /// <summary>Gets the unique segment identifier.</summary>
    public Guid SegmentId { get; init; }

    /// <summary>Gets the previous segment identifier for chain linking.</summary>
    public Guid? PrevSegmentId { get; init; }

    /// <summary>Gets the HMAC of the previous segment for integrity verification.</summary>
    public byte[] PrevSegmentHmac { get; init; } = Array.Empty<byte>();

    /// <summary>Gets the fingerprint of the signer's public key.</summary>
    public byte[] SignerPubKeyFingerprint { get; init; } = Array.Empty<byte>();

    /// <summary>Gets the key identifier of the signer.</summary>
    public string SignerKeyId { get; init; } = string.Empty;

    /// <summary>Gets the timestamp when this segment was created.</summary>
    public DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the monotonic segment sequence number.</summary>
    public long SegmentSeq { get; init; }

    /// <summary>Gets the list of key transitions effective in this segment.</summary>
    public List<KeyTransitionRefDto> EffectiveTransitions { get; init; } = new();

    /// <summary>Creates a <see cref="SegmentHeaderDto"/> from a <see cref="SegmentHeader"/>.</summary>
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

    /// <summary>Converts this DTO to a <see cref="SegmentHeader"/> domain object.</summary>
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
    /// <summary>Gets the key identifier being rotated from.</summary>
    public string OldKeyId { get; init; } = string.Empty;

    /// <summary>Gets the key identifier being rotated to.</summary>
    public string NewKeyId { get; init; } = string.Empty;
}

/// <summary>JSON-friendly DTO for <see cref="AuditRecord"/>.</summary>
internal sealed record AuditRecordDto
{
    /// <summary>Gets the audit event type.</summary>
    public string EventType { get; init; } = string.Empty;

    /// <summary>Gets the timestamp of the audit event.</summary>
    public DateTimeOffset At { get; init; }

    /// <summary>Gets the principal that performed the action.</summary>
    public AuthContextDto Principal { get; init; } = new();

    /// <summary>Gets the serialized JSON content of the audit event.</summary>
    public string ContentJson { get; init; } = string.Empty;

    /// <summary>Gets the list of resource references associated with this event.</summary>
    public List<string> ResourceRefs { get; init; } = new();

    /// <summary>Creates an <see cref="AuditRecordDto"/> from an <see cref="AuditRecord"/>.</summary>
    public static AuditRecordDto From(AuditRecord r) => new()
    {
        EventType = r.EventType,
        At = r.At,
        Principal = AuthContextDto.From(r.Principal),
        ContentJson = r.ContentJson,
        ResourceRefs = r.ResourceRefs.ToList(),
    };

    /// <summary>Converts this DTO to an <see cref="AuditRecord"/> domain object.</summary>
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
    /// <summary>Gets the principal identifier.</summary>
    public string PrincipalId { get; init; } = string.Empty;

    /// <summary>Gets the human-readable display name.</summary>
    public string DisplayName { get; init; } = string.Empty;

    /// <summary>Gets the list of authorization scopes.</summary>
    public List<string> Scopes { get; init; } = new();

    /// <summary>Gets the time the authentication context was issued.</summary>
    public DateTimeOffset IssuedAtUtc { get; init; }

    /// <summary>Gets the optional expiration time.</summary>
    public DateTimeOffset? ExpiresAtUtc { get; init; }

    /// <summary>Creates an <see cref="AuthContextDto"/> from an <see cref="AuthContext"/>.</summary>
    public static AuthContextDto From(AuthContext a) => new()
    {
        PrincipalId = a.PrincipalId,
        DisplayName = a.DisplayName,
        Scopes = a.Scopes.ToList(),
        IssuedAtUtc = a.IssuedAtUtc,
        ExpiresAtUtc = a.ExpiresAtUtc,
    };

    /// <summary>Converts this DTO to an <see cref="AuthContext"/> domain object.</summary>
    public AuthContext ToAuthContext() => new()
    {
        PrincipalId = this.PrincipalId,
        DisplayName = this.DisplayName,
        Scopes = this.Scopes.ToImmutableArray(),
        IssuedAtUtc = this.IssuedAtUtc,
        ExpiresAtUtc = this.ExpiresAtUtc,
    };
}
