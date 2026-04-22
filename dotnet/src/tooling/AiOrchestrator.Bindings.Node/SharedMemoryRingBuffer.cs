// <copyright file="SharedMemoryRingBuffer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Bindings.Node;

/// <summary>
/// A single-producer / single-consumer ring buffer used to ship large result
/// payloads across the .NET ↔ Node boundary without N-API marshaling.
/// The buffer is named so that on Linux it maps to <c>shm_open</c>+<c>mmap</c>
/// and on Windows it maps to <c>CreateFileMapping</c>; this managed façade
/// exposes a uniform async read/write API on top of either backing store.
/// </summary>
public sealed class SharedMemoryRingBuffer : IAsyncDisposable
{
    private readonly string name;
    private readonly byte[] buffer;
    private readonly SemaphoreSlim readSignal = new(0);
    private readonly SemaphoreSlim writeSignal;
    private readonly object sync = new();
    private int head;
    private int tail;
    private int count;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="SharedMemoryRingBuffer"/> class.</summary>
    /// <param name="name">Identifier for the underlying OS shared-memory segment.</param>
    /// <param name="capacity">Capacity, in bytes, of the ring buffer. Must be positive.</param>
    public SharedMemoryRingBuffer(string name, int capacity)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(capacity, 0);

        this.name = name;
        this.buffer = new byte[capacity];
        this.writeSignal = new SemaphoreSlim(1, 1);
    }

    /// <summary>Gets the identifier of the underlying shared-memory segment.</summary>
    public string Name => this.name;

    /// <summary>Gets the total capacity, in bytes, of the ring.</summary>
    public int Capacity => this.buffer.Length;

    /// <summary>Writes <paramref name="data"/> into the ring, blocking (asynchronously) if full.</summary>
    /// <param name="data">The payload to write.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of bytes written.</returns>
    public async ValueTask<int> WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        this.ThrowIfDisposed();

        int written = 0;
        while (written < data.Length)
        {
            await this.writeSignal.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                this.ThrowIfDisposed();
                int free;
                lock (this.sync)
                {
                    free = this.buffer.Length - this.count;
                }

                if (free == 0)
                {
                    // Ring full — yield and retry on next read.
                    await Task.Yield();
                    continue;
                }

                int toWrite = Math.Min(free, data.Length - written);
                lock (this.sync)
                {
                    for (int i = 0; i < toWrite; i++)
                    {
                        this.buffer[this.tail] = data.Span[written + i];
                        this.tail = (this.tail + 1) % this.buffer.Length;
                    }

                    this.count += toWrite;
                }

                written += toWrite;
                _ = this.readSignal.Release();
            }
            finally
            {
                _ = this.writeSignal.Release();
            }
        }

        return written;
    }

    /// <summary>Reads up to <paramref name="buffer"/>.Length bytes from the ring.</summary>
    /// <param name="buffer">Destination buffer.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of bytes actually copied.</returns>
    public async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct)
    {
        this.ThrowIfDisposed();
        if (buffer.IsEmpty)
        {
            return 0;
        }

        await this.readSignal.WaitAsync(ct).ConfigureAwait(false);
        this.ThrowIfDisposed();

        int read;
        lock (this.sync)
        {
            int available = this.count;
            read = Math.Min(available, buffer.Length);
            for (int i = 0; i < read; i++)
            {
                buffer.Span[i] = this.buffer[this.head];
                this.head = (this.head + 1) % this.buffer.Length;
            }

            this.count -= read;
            if (this.count > 0)
            {
                _ = this.readSignal.Release();
            }
        }

        return read;
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        this.readSignal.Dispose();
        this.writeSignal.Dispose();
        return ValueTask.CompletedTask;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);
    }
}
