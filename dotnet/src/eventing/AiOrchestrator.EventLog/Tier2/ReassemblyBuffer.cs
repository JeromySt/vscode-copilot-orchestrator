// <copyright file="ReassemblyBuffer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>
/// Bounded buffer used by <see cref="TieredReader"/> to reassemble a partial T2 record across
/// multiple read chunks. Both byte size and elapsed time are bounded (T2-READ-11); when either
/// budget is exceeded the buffer is reset and an <see cref="EventLogReassemblyAbandoned"/> event
/// is emitted on the supplied bus.
/// </summary>
internal sealed class ReassemblyBuffer
{
    private readonly int maxBytes;
    private readonly TimeSpan timeout;
    private readonly IClock clock;
    private byte[] buffer = Array.Empty<byte>();
    private int length;
    private long startMs;

    /// <summary>Initializes a new instance of the <see cref="ReassemblyBuffer"/> class.</summary>
    /// <param name="maxBytes">Maximum bytes that may be buffered before the partial record is abandoned.</param>
    /// <param name="timeout">Maximum wall-clock duration before the partial record is abandoned.</param>
    /// <param name="clock">Clock used for the elapsed-time budget.</param>
    public ReassemblyBuffer(int maxBytes, TimeSpan timeout, IClock clock)
    {
        if (maxBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        }

        this.maxBytes = maxBytes;
        this.timeout = timeout;
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Gets the number of bytes currently buffered (used by diagnostics).</summary>
    public int BytesBuffered => this.length;

    /// <summary>Gets the wall-clock milliseconds since the buffer first began accumulating, or 0 if empty.</summary>
    public long ElapsedMs => this.length == 0 ? 0 : Math.Max(0, this.clock.MonotonicMilliseconds - this.startMs);

    /// <summary>Appends partial bytes to the buffer.</summary>
    /// <param name="partial">The bytes observed since the previous call.</param>
    /// <returns><see langword="true"/> on success; <see langword="false"/> if the byte budget would be exceeded.</returns>
    public bool TryAppend(ReadOnlySpan<byte> partial)
    {
        if (partial.IsEmpty)
        {
            return true;
        }

        if (this.length == 0)
        {
            this.startMs = this.clock.MonotonicMilliseconds;
        }

        var nextLen = this.length + partial.Length;
        if (nextLen > this.maxBytes)
        {
            return false;
        }

        if (this.buffer.Length < nextLen)
        {
            var grown = new byte[Math.Max(nextLen, Math.Max(64, this.buffer.Length * 2))];
            if (this.length > 0)
            {
                Array.Copy(this.buffer, grown, this.length);
            }

            this.buffer = grown;
        }

        partial.CopyTo(this.buffer.AsSpan(this.length));
        this.length = nextLen;
        return true;
    }

    /// <summary>Returns <see langword="true"/> if the time budget has been exceeded.</summary>
    /// <returns>Whether the timeout has elapsed since the partial record began.</returns>
    public bool IsTimedOut()
        => this.length > 0 && (this.clock.MonotonicMilliseconds - this.startMs) > (long)this.timeout.TotalMilliseconds;

    /// <summary>Returns the buffered bytes as a span and clears the buffer.</summary>
    /// <returns>The accumulated bytes; the buffer is empty afterwards.</returns>
    public ReadOnlyMemory<byte> Flush()
    {
        var result = this.buffer.AsMemory(0, this.length);
        var copy = result.ToArray();
        this.length = 0;
        return copy;
    }

    /// <summary>Discards any buffered bytes without emitting events.</summary>
    public void Reset()
    {
        this.length = 0;
    }
}
