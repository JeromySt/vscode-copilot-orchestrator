// <copyright file="ConPtyHandle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Pty;

/// <summary>A safe handle that closes a ConPTY via <c>ClosePseudoConsole</c>.</summary>
internal sealed class ConPtyHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    internal ConPtyHandle(nint hPcon)
        : base(ownsHandle: true)
    {
        this.SetHandle(hPcon);
    }

    /// <inheritdoc/>
    protected override bool ReleaseHandle()
    {
        ConPtyNative.ClosePseudoConsole(this.handle);
        return true;
    }
}
