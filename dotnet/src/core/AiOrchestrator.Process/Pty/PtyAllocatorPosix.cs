// <copyright file="PtyAllocatorPosix.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Pty;

/// <summary>
/// POSIX implementation of <see cref="IPtyAllocator"/> using <c>posix_openpt(3)</c>,
/// <c>grantpt(3)</c>, <c>unlockpt(3)</c>, and <c>ptsname(3)</c> to allocate a
/// master/slave PTY pair.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class PtyAllocatorPosix : IPtyAllocator
{
    // O_RDWR | O_NOCTTY
    private const int OpenFlags = 0x0002 | 0x0400;

    /// <inheritdoc/>
    public ValueTask<PtyPair> AllocateAsync(int rows, int cols, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var masterFd = PosixPtyNative.PosixOpenPt(OpenFlags);
        if (masterFd < 0)
        {
            throw new InvalidOperationException(
                $"posix_openpt failed: errno={Marshal.GetLastPInvokeError()}");
        }

        if (PosixPtyNative.GrantPt(masterFd) != 0)
        {
            _ = PosixPtyNative.Close(masterFd);
            throw new InvalidOperationException("grantpt failed");
        }

        if (PosixPtyNative.UnlockPt(masterFd) != 0)
        {
            _ = PosixPtyNative.Close(masterFd);
            throw new InvalidOperationException("unlockpt failed");
        }

        var slaveName = PosixPtyNative.PtsName(masterFd);
        if (slaveName is null)
        {
            _ = PosixPtyNative.Close(masterFd);
            throw new InvalidOperationException("ptsname returned null");
        }

        var slaveFd = PosixPtyNative.Open(slaveName, OpenFlags);
        if (slaveFd < 0)
        {
            _ = PosixPtyNative.Close(masterFd);
            throw new InvalidOperationException($"open slave pty failed: errno={Marshal.GetLastPInvokeError()}");
        }

        var masterHandle = new SafeFileHandle(new nint(masterFd), ownsHandle: true);
        var slaveHandle = new SafeFileHandle(new nint(slaveFd), ownsHandle: true);

        return ValueTask.FromResult(new PtyPair(masterHandle, slaveHandle));
    }
}
