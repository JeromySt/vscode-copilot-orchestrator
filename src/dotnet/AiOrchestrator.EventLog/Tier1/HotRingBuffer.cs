// <copyright file="HotRingBuffer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.EventLog.Tier1;

/// <summary>
/// Fixed-capacity in-memory ring of the most recent envelopes. Acts as the T1 "hot" tier
/// providing fast random access by sequence number for live subscribers without round-tripping
/// through T2 disk reads.
/// </summary>
internal sealed class HotRingBuffer
{
    private readonly object gate = new();
    private readonly EventEnvelope?[] slots;
    private long maxSeq;
    private long minSeq;
    private int count;

    /// <summary>Initializes a new instance of the <see cref="HotRingBuffer"/> class.</summary>
    /// <param name="capacity">Maximum number of envelopes retained; older entries are evicted on insert.</param>
    public HotRingBuffer(int capacity)
    {
        if (capacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacity));
        }

        this.slots = new EventEnvelope?[capacity];
    }

    /// <summary>Inserts an envelope, evicting the oldest when at capacity.</summary>
    /// <param name="envelope">The envelope to retain.</param>
    public void Add(EventEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        lock (this.gate)
        {
            var slot = (int)(envelope.RecordSeq % this.slots.Length);
            this.slots[slot] = envelope;
            if (envelope.RecordSeq > this.maxSeq)
            {
                this.maxSeq = envelope.RecordSeq;
            }

            this.count = Math.Min(this.count + 1, this.slots.Length);
            this.minSeq = Math.Max(1, this.maxSeq - this.count + 1);
        }
    }

    /// <summary>Snapshots the buffer contents into an array.</summary>
    /// <returns>An array of retained envelopes ordered by sequence number ascending.</returns>
    public EventEnvelope[] Snapshot()
    {
        lock (this.gate)
        {
            var list = new List<EventEnvelope>(this.count);
            for (var seq = this.minSeq; seq <= this.maxSeq; seq++)
            {
                var slot = (int)(seq % this.slots.Length);
                var ev = this.slots[slot];
                if (ev is not null && ev.RecordSeq == seq)
                {
                    list.Add(ev);
                }
            }

            return list.ToArray();
        }
    }
}
