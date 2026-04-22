// <copyright file="SegmentCodec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Immutable;
using System.IO;
using System.Text.Json;

namespace AiOrchestrator.Audit.Chain;

/// <summary>
/// Binary segment-file codec implementing INV-10:
/// <c>magic 'AIOA' (4) + u16 version + u32 headerLen + headerJson + u32 recordCount +
/// (u32 recLen + recJson) * recordCount + u32 hmacLen + hmac + u32 sigLen + sig + u32 pubLen + pub</c>.
/// The "body" range used for HMAC + Ed25519 covers everything from the magic up to and
/// including the final record (i.e., excluding hmac/sig/pubkey trailer).
/// </summary>
internal static class SegmentCodec
{
    /// <summary>The 4-byte magic prefix written at the start of every segment file.</summary>
    public static readonly byte[] Magic = "AIOA"u8.ToArray();

    /// <summary>The current segment-format version (INV-10).</summary>
    public const ushort FormatVersion = 1;

    /// <summary>Serializes the body bytes (magic..last record) for a header + records pair.</summary>
    /// <param name="header">The segment header.</param>
    /// <param name="records">The records to embed.</param>
    /// <returns>The body byte array.</returns>
    public static byte[] SerializeBody(SegmentHeader header, ImmutableArray<AuditRecord> records)
    {
        using var ms = new MemoryStream();
        ms.Write(Magic);
        WriteUInt16LE(ms, FormatVersion);

        var headerJson = JsonSerializer.SerializeToUtf8Bytes(SegmentHeaderDto.From(header), AuditJsonContext.Default.SegmentHeaderDto);
        WriteUInt32LE(ms, (uint)headerJson.Length);
        ms.Write(headerJson);

        WriteUInt32LE(ms, (uint)records.Length);
        foreach (var rec in records)
        {
            var recJson = JsonSerializer.SerializeToUtf8Bytes(AuditRecordDto.From(rec), AuditJsonContext.Default.AuditRecordDto);
            WriteUInt32LE(ms, (uint)recJson.Length);
            ms.Write(recJson);
        }

        return ms.ToArray();
    }

    /// <summary>Builds the trailer (HMAC + signature + pubkey) byte sequence appended after the body.</summary>
    /// <param name="hmac">32-byte chain HMAC.</param>
    /// <param name="signature">64-byte Ed25519 signature.</param>
    /// <param name="pubKey">32-byte Ed25519 public key.</param>
    /// <returns>The trailer byte array.</returns>
    public static byte[] SerializeTrailer(byte[] hmac, byte[] signature, byte[] pubKey)
    {
        using var ms = new MemoryStream();
        WriteUInt32LE(ms, (uint)hmac.Length);
        ms.Write(hmac);
        WriteUInt32LE(ms, (uint)signature.Length);
        ms.Write(signature);
        WriteUInt32LE(ms, (uint)pubKey.Length);
        ms.Write(pubKey);
        return ms.ToArray();
    }

    /// <summary>Reads a complete segment from a byte buffer.</summary>
    /// <param name="raw">The complete file contents.</param>
    /// <param name="bodyLength">Outputs the length, in bytes, of the body region.</param>
    /// <returns>The fully parsed <see cref="Segment"/>.</returns>
    /// <exception cref="InvalidDataException">Thrown when the file does not match the expected format.</exception>
    public static Segment Decode(byte[] raw, out int bodyLength)
    {
        var pos = 0;
        if (raw.Length < Magic.Length + 2)
        {
            throw new InvalidDataException("Segment too short for magic + version header.");
        }

        if (!raw.AsSpan(0, Magic.Length).SequenceEqual(Magic))
        {
            throw new InvalidDataException("Segment magic is not 'AIOA'.");
        }

        pos += Magic.Length;
        var version = BinaryPrimitives.ReadUInt16LittleEndian(raw.AsSpan(pos, 2));
        pos += 2;
        if (version != FormatVersion)
        {
            throw new InvalidDataException($"Unsupported segment format version {version} (expected {FormatVersion}).");
        }

        var headerLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
        pos += 4;
        var headerJson = raw.AsSpan(pos, headerLen).ToArray();
        pos += headerLen;
        var headerDto = JsonSerializer.Deserialize(headerJson, AuditJsonContext.Default.SegmentHeaderDto)
            ?? throw new InvalidDataException("Segment header deserialized to null.");
        var header = headerDto.ToHeader();

        var recordCount = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
        pos += 4;
        var recordsBuilder = ImmutableArray.CreateBuilder<AuditRecord>(recordCount);
        for (var i = 0; i < recordCount; i++)
        {
            var recLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
            pos += 4;
            var recJson = raw.AsSpan(pos, recLen).ToArray();
            pos += recLen;
            var recDto = JsonSerializer.Deserialize(recJson, AuditJsonContext.Default.AuditRecordDto)
                ?? throw new InvalidDataException("Audit record deserialized to null.");
            recordsBuilder.Add(recDto.ToRecord());
        }

        bodyLength = pos;

        var hmacLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
        pos += 4;
        var hmac = raw.AsSpan(pos, hmacLen).ToArray();
        pos += hmacLen;

        var sigLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
        pos += 4;
        var sig = raw.AsSpan(pos, sigLen).ToArray();
        pos += sigLen;

        var pubLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(pos, 4));
        pos += 4;
        var pub = raw.AsSpan(pos, pubLen).ToArray();

        return new Segment
        {
            Header = header,
            Records = recordsBuilder.ToImmutable(),
            Hmac = hmac,
            Ed25519Signature = sig,
            EmbeddedPublicKey = pub,
        };
    }

    private static void WriteUInt16LE(Stream s, ushort v)
    {
        Span<byte> b = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(b, v);
        s.Write(b);
    }

    private static void WriteUInt32LE(Stream s, uint v)
    {
        Span<byte> b = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(b, v);
        s.Write(b);
    }
}
