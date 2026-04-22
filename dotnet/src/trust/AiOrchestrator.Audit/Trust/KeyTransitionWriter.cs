// <copyright file="KeyTransitionWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;
using AiOrchestrator.Audit.Crypto;

namespace AiOrchestrator.Audit.Trust;

/// <summary>
/// Builds and verifies cross-signed <see cref="KeyTransition"/> records (INV-3).
/// This and <c>AuditLog.AppendAsync</c> are the ONLY allowed call sites for
/// <see cref="EcdsaSigner.Sign"/> in the audit subsystem (INV-6).
/// </summary>
public sealed class KeyTransitionWriter
{
    private readonly EcdsaSigner signer;

    /// <summary>Initializes a new <see cref="KeyTransitionWriter"/>.</summary>
    /// <param name="signer">The Ed25519 signer used for cross-signing.</param>
    public KeyTransitionWriter(EcdsaSigner signer)
    {
        this.signer = signer ?? throw new ArgumentNullException(nameof(signer));
    }

    /// <summary>Builds the canonical message bytes that BOTH old and new keys must sign for a transition.</summary>
    /// <param name="oldKeyId">The retiring key identifier.</param>
    /// <param name="newKeyId">The replacement key identifier.</param>
    /// <param name="oldPubKey">32-byte Ed25519 public key of the retiring key.</param>
    /// <param name="newPubKey">32-byte Ed25519 public key of the replacement key.</param>
    /// <param name="at">Wall-clock instant of the transition.</param>
    /// <param name="reason">Reason for rotation.</param>
    /// <returns>The canonical message bytes.</returns>
    public static byte[] BuildTransitionMessage(string oldKeyId, string newKeyId, ReadOnlySpan<byte> oldPubKey, ReadOnlySpan<byte> newPubKey, DateTimeOffset at, TransitionReason reason)
    {
        using var ms = new MemoryStream();
        WritePrefixedString(ms, "AIO-KEY-TRANSITION-V1");
        WritePrefixedString(ms, oldKeyId);
        WritePrefixedString(ms, newKeyId);
        WritePrefixedBytes(ms, oldPubKey);
        WritePrefixedBytes(ms, newPubKey);
        Span<byte> tickBuf = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(tickBuf, at.UtcTicks);
        ms.Write(tickBuf);
        ms.WriteByte((byte)reason);
        return ms.ToArray();
    }

    /// <summary>Issues a fully cross-signed <see cref="KeyTransition"/>.</summary>
    /// <param name="oldKeyId">Retiring key id.</param>
    /// <param name="newKeyId">Replacement key id.</param>
    /// <param name="oldPubKey">Retiring key 32-byte pubkey.</param>
    /// <param name="oldPrivKey">Retiring key 32-byte privkey.</param>
    /// <param name="newPubKey">Replacement key 32-byte pubkey.</param>
    /// <param name="newPrivKey">Replacement key 32-byte privkey.</param>
    /// <param name="at">Wall-clock instant.</param>
    /// <param name="reason">Reason for rotation.</param>
    /// <returns>A fully cross-signed transition.</returns>
    public KeyTransition Issue(
        string oldKeyId,
        string newKeyId,
        byte[] oldPubKey,
        byte[] oldPrivKey,
        byte[] newPubKey,
        byte[] newPrivKey,
        DateTimeOffset at,
        TransitionReason reason)
    {
        var msg = BuildTransitionMessage(oldKeyId, newKeyId, oldPubKey, newPubKey, at, reason);
        var oldSig = this.signer.Sign(msg, oldPrivKey);
        var newSig = this.signer.Sign(msg, newPrivKey);
        return new KeyTransition
        {
            OldKeyId = oldKeyId,
            NewKeyId = newKeyId,
            OldPubKey = oldPubKey,
            NewPubKey = newPubKey,
            OldKeySignature = oldSig,
            NewKeySignature = newSig,
            At = at,
            Reason = reason,
        };
    }

    /// <summary>Verifies the cross-signature pair on a transition (INV-3).</summary>
    /// <param name="transition">The transition to verify.</param>
    /// <returns><see langword="true"/> if both signatures verify under their respective keys.</returns>
    public bool VerifyCrossSignature(KeyTransition transition)
    {
        ArgumentNullException.ThrowIfNull(transition);
        var msg = BuildTransitionMessage(transition.OldKeyId, transition.NewKeyId, transition.OldPubKey, transition.NewPubKey, transition.At, transition.Reason);
        return this.signer.Verify(msg, transition.OldKeySignature, transition.OldPubKey)
            && this.signer.Verify(msg, transition.NewKeySignature, transition.NewPubKey);
    }

    private static void WritePrefixedString(Stream s, string v)
    {
        var bytes = Encoding.UTF8.GetBytes(v);
        WritePrefixedBytes(s, bytes);
    }

    private static void WritePrefixedBytes(Stream s, ReadOnlySpan<byte> v)
    {
        Span<byte> lenBuf = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lenBuf, (uint)v.Length);
        s.Write(lenBuf);
        s.Write(v);
    }
}
