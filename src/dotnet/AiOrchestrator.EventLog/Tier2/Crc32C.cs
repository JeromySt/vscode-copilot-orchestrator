// <copyright file="Crc32C.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#if NET5_0_OR_GREATER
using System.Runtime.Intrinsics.X86;
#endif

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>
/// Software/hardware-accelerated CRC-32C (Castagnoli, reversed polynomial 0x82F63B78). The package
/// reference provided by the host (System.IO.Hashing) does not yet expose <c>Crc32C</c> at the
/// pinned version, so the implementation lives here. Hardware acceleration is used when the
/// running CPU advertises SSE4.2; otherwise a table-driven byte-at-a-time loop is used.
/// </summary>
internal static class Crc32C
{
    private static readonly uint[] Table = BuildTable();

    /// <summary>Computes the CRC-32C of <paramref name="data"/>.</summary>
    /// <param name="data">The bytes to hash.</param>
    /// <returns>The CRC-32C value.</returns>
    public static uint HashToUInt32(ReadOnlySpan<byte> data) => ~AppendRaw(~0u, data);

    /// <summary>Continues a running hash with additional <paramref name="data"/>.</summary>
    /// <param name="seed">The running CRC value (start with 0).</param>
    /// <param name="data">The bytes to fold into the running CRC.</param>
    /// <returns>The updated CRC value.</returns>
    public static uint Append(uint seed, ReadOnlySpan<byte> data) => ~AppendRaw(~seed, data);

    private static uint AppendRaw(uint crc, ReadOnlySpan<byte> data)
    {
#if NET5_0_OR_GREATER
        if (Sse42.IsSupported)
        {
            var i = 0;
#if NET5_0_OR_GREATER
            if (Sse42.X64.IsSupported)
            {
                while (i + 8 <= data.Length)
                {
                    crc = (uint)Sse42.X64.Crc32(crc, System.Buffers.Binary.BinaryPrimitives.ReadUInt64LittleEndian(data.Slice(i, 8)));
                    i += 8;
                }
            }
#endif
            while (i + 4 <= data.Length)
            {
                crc = Sse42.Crc32(crc, System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(i, 4)));
                i += 4;
            }

            while (i < data.Length)
            {
                crc = Sse42.Crc32(crc, data[i]);
                i++;
            }

            return crc;
        }
#endif

        var table = Table;
        for (var j = 0; j < data.Length; j++)
        {
            crc = table[(crc ^ data[j]) & 0xFFu] ^ (crc >> 8);
        }

        return crc;
    }

    private static uint[] BuildTable()
    {
        const uint poly = 0x82F63B78u;
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            var c = i;
            for (var k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? (c >> 1) ^ poly : c >> 1;
            }

            table[i] = c;
        }

        return table;
    }
}
