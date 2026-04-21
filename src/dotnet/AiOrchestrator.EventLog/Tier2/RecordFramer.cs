// <copyright file="RecordFramer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Buffers.Binary;

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>
/// T2 wire-format encoder/decoder. Frames are laid out as:
/// <c>[u32 length][u64 recordSeq][payload bytes][u32 crc32c-of-(length+recordSeq+payload)]</c>
/// per INV-1 / T2-LOG-1.
/// </summary>
internal static class RecordFramer
{
    /// <summary>Number of header bytes (u32 length + u64 recordSeq).</summary>
    public const int HeaderSize = sizeof(uint) + sizeof(long);

    /// <summary>Number of trailing CRC bytes.</summary>
    public const int CrcSize = sizeof(uint);

    /// <summary>Total framing overhead (header + trailing CRC).</summary>
    public const int Overhead = HeaderSize + CrcSize;

    /// <summary>Computes the total framed size for a payload of <paramref name="payloadLength"/> bytes.</summary>
    /// <param name="payloadLength">The size of the unframed payload in bytes.</param>
    /// <returns>The total framed size including header and trailing CRC.</returns>
    public static int FramedSize(int payloadLength) => Overhead + payloadLength;

    /// <summary>Writes a framed record into <paramref name="output"/>.</summary>
    /// <param name="payload">The opaque payload to wrap.</param>
    /// <param name="output">A destination span; must be at least <see cref="FramedSize(int)"/> long.</param>
    /// <param name="recordSeq">The monotonic sequence number to embed.</param>
    /// <returns>The total number of bytes written.</returns>
    public static int Frame(ReadOnlySpan<byte> payload, Span<byte> output, long recordSeq)
    {
        var total = FramedSize(payload.Length);
        if (output.Length < total)
        {
            throw new ArgumentException("Destination span is too small.", nameof(output));
        }

        BinaryPrimitives.WriteUInt32LittleEndian(output, (uint)payload.Length);
        BinaryPrimitives.WriteInt64LittleEndian(output[sizeof(uint)..], recordSeq);
        payload.CopyTo(output[HeaderSize..]);

        var crcInput = output[..(HeaderSize + payload.Length)];
        var crc = Crc32C.HashToUInt32(crcInput);
        BinaryPrimitives.WriteUInt32LittleEndian(output.Slice(HeaderSize + payload.Length, CrcSize), crc);

        return total;
    }

    /// <summary>Attempts to consume one framed record from <paramref name="input"/>.</summary>
    /// <param name="input">The buffered byte sequence to inspect.</param>
    /// <param name="lastEmittedSeq">The most recently emitted record sequence number for monotonicity validation; pass 0 for the first record.</param>
    /// <param name="record">When the result is <see cref="FrameError.None"/>, populated with the decoded record. The payload is owned by <paramref name="input"/>.</param>
    /// <param name="consumed">The position within <paramref name="input"/> immediately after the consumed frame, or the original start when nothing was consumed.</param>
    /// <param name="error">On failure, the failure mode.</param>
    /// <returns><see langword="true"/> when a complete, valid frame was decoded; otherwise <see langword="false"/>.</returns>
    public static bool TryUnframe(
        ReadOnlySequence<byte> input,
        long lastEmittedSeq,
        out RawRecord record,
        out SequencePosition consumed,
        out FrameError error)
    {
        record = default;
        consumed = input.Start;
        error = FrameError.None;

        if (input.Length < HeaderSize)
        {
            error = FrameError.IncompleteHeader;
            return false;
        }

        Span<byte> header = stackalloc byte[HeaderSize];
        input.Slice(0, HeaderSize).CopyTo(header);
        var payloadLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(header);
        var recordSeq = BinaryPrimitives.ReadInt64LittleEndian(header[sizeof(uint)..]);

        var totalLen = (long)Overhead + payloadLen;
        if (input.Length < totalLen)
        {
            error = FrameError.IncompleteBody;
            return false;
        }

        // Acquire a contiguous view of header+payload for CRC computation.
        var headerAndPayload = input.Slice(0, HeaderSize + payloadLen);

        uint crc;
        if (headerAndPayload.IsSingleSegment)
        {
            crc = Crc32C.HashToUInt32(headerAndPayload.FirstSpan);
        }
        else
        {
            uint running = 0;
            foreach (var seg in headerAndPayload)
            {
                running = Crc32C.Append(running, seg.Span);
            }

            crc = running;
        }

        Span<byte> trailer = stackalloc byte[CrcSize];
        input.Slice(HeaderSize + payloadLen, CrcSize).CopyTo(trailer);
        var expected = BinaryPrimitives.ReadUInt32LittleEndian(trailer);

        if (crc != expected)
        {
            error = FrameError.CrcMismatch;
            return false;
        }

        if (recordSeq <= lastEmittedSeq)
        {
            error = FrameError.RecordSeqRegression;
            return false;
        }

        // Materialise the payload as a contiguous ReadOnlyMemory view to keep RawRecord struct-only.
        var payloadSeq = input.Slice(HeaderSize, payloadLen);
        ReadOnlyMemory<byte> payload = payloadSeq.IsSingleSegment
            ? payloadSeq.First
            : payloadSeq.ToArray();

        record = new RawRecord(recordSeq, payload);
        consumed = input.GetPosition(totalLen);
        return true;
    }
}
