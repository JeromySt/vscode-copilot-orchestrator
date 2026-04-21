// <copyright file="ApprovalIssuer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using AiOrchestrator.HookGate.Nonce;

namespace AiOrchestrator.HookGate;

/// <summary>
/// Computes the canonical form of a <see cref="HookCheckInRequest"/> and the HMAC-SHA256
/// keyed by a <see cref="Nonce"/> (INV-6 / INV-10).
/// </summary>
internal static class ApprovalIssuer
{
    /// <summary>Produces the deterministic canonical form used as the HMAC input.</summary>
    /// <param name="request">Request to canonicalize.</param>
    /// <returns>UTF-8 bytes of the canonical form.</returns>
    public static byte[] CanonicalBytes(HookCheckInRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var sb = new StringBuilder();
        _ = sb.Append("kind=").Append(request.Kind.ToString()).Append('\n');
        _ = sb.Append("hookFile=").Append(request.HookFile.Value).Append('\n');
        _ = sb.Append("worktree=").Append(request.WorktreeRoot.Value).Append('\n');
        _ = sb.Append("principal=").Append(request.Principal.PrincipalId).Append('\n');
        _ = sb.Append("env=\n");
        foreach (var kv in request.Env.OrderBy(k => k.Key, StringComparer.Ordinal))
        {
            _ = sb.Append("  ").Append(kv.Key).Append('=').Append(kv.Value).Append('\n');
        }

        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    public static byte[] ComputeHmac(Nonce.Nonce nonce, HookCheckInRequest request)
    {
        ArgumentNullException.ThrowIfNull(nonce);
        var key = Convert.FromBase64String(nonce.Value);
        var payload = CanonicalBytes(request);
        return HMACSHA256.HashData(key, payload);
    }

    public static string NewTokenId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16))
        .ToLowerInvariant();

    public static HookApproval Issue(Nonce.Nonce nonce, HookCheckInRequest request, DateTimeOffset now, TimeSpan ttl)
    {
        var hmac = ComputeHmac(nonce, request);
        return new HookApproval
        {
            TokenId = NewTokenId(),
            Hmac = hmac,
            IssuedAt = now,
            ExpiresAt = now + ttl,
            Principal = request.Principal,
        };
    }

    public static string FormatTimestamp(DateTimeOffset t) => t.ToString("O", CultureInfo.InvariantCulture);
}
