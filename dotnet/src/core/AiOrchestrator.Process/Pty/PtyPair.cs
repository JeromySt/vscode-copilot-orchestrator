// <copyright file="PtyPair.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Process.Pty;

/// <summary>
/// Holds the master and slave handles of an allocated pseudo-terminal.
/// Dispose to close both handles and release OS resources.
/// </summary>
/// <param name="Master">The master side of the PTY. The spawner reads/writes this to communicate with the child.</param>
/// <param name="Slave">The slave side of the PTY. The child process inherits this as its controlling terminal.</param>
public sealed record PtyPair(SafeHandle Master, SafeHandle Slave) : IDisposable
{
    private int disposed;

    /// <inheritdoc/>
    public void Dispose()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        this.Master.Dispose();
        this.Slave.Dispose();
    }
}
