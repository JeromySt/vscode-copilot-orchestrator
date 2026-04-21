// <copyright file="ConPtyAllocatorWindows.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Pty;

/// <summary>
/// Windows implementation of <see cref="IPtyAllocator"/> using the ConPTY API
/// (<c>CreatePseudoConsole</c> / <c>ClosePseudoConsole</c>).
/// </summary>
public sealed partial class ConPtyAllocatorWindows : IPtyAllocator
{
    /// <inheritdoc/>
    public async ValueTask<PtyPair> AllocateAsync(int rows, int cols, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Create an anonymous pipe: the master side reads/writes via the pipe ends
        if (!CreatePipe(out var pipeRead, out var pipeWrite, nint.Zero, 0))
        {
            throw new InvalidOperationException(
                $"CreatePipe failed: {Marshal.GetLastPInvokeError()}");
        }

        var size = new ConPtyNative.Coord { X = (short)cols, Y = (short)rows };
        var hr = ConPtyNative.CreatePseudoConsole(size, pipeRead, pipeWrite, 0, out var hPcon);
        if (hr < 0)
        {
            pipeRead.Dispose();
            pipeWrite.Dispose();
            throw new InvalidOperationException(
                FormattableString.Invariant($"CreatePseudoConsole failed: HRESULT=0x{hr:X8}"));
        }

        // The master handle wraps the ConPTY handle; calls ClosePseudoConsole on dispose
        var masterHandle = new ConPtyHandle(new nint(hPcon));

        // The slave is the pipe's write end (process inherits this)
        pipeRead.Dispose(); // Not needed outside the pair

        await Task.CompletedTask.ConfigureAwait(false); // ensure async shape

        return new PtyPair(masterHandle, pipeWrite);
    }

    [LibraryImport("kernel32", EntryPoint = "CreatePipe", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreatePipe(
        out SafeFileHandle hReadPipe,
        out SafeFileHandle hWritePipe,
        nint lpPipeAttributes,
        int nSize);
}
