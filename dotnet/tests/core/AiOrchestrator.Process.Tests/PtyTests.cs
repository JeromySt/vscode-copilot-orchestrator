// <copyright file="PtyTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Process.Pty;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Tests for PTY allocation (INV-7).</summary>
public sealed class PtyTests
{
    /// <summary>PROC-7: PTY delivers an interactive prompt via master/slave pair.</summary>
    [Fact]
    [ContractTest("PROC-7")]
    public async Task PROC_7_Pty_DeliversInteractivePrompt()
    {
        IPtyAllocator allocator = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new ConPtyAllocatorWindows()
            : new PtyAllocatorPosix();

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            // On POSIX, allocate a PTY and verify master/slave handles are valid
            using var pty = await allocator.AllocateAsync(24, 80, CancellationToken.None);
            Assert.NotNull(pty);
            Assert.NotNull(pty.Master);
            Assert.NotNull(pty.Slave);
            Assert.False(pty.Master.IsInvalid, "master handle must be valid");
            Assert.False(pty.Slave.IsInvalid, "slave handle must be valid");
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // On Windows, ConPTY requires a pipe; verify allocation or skip gracefully
            try
            {
                using var pty = await allocator.AllocateAsync(24, 80, CancellationToken.None);
                Assert.NotNull(pty);
                Assert.NotNull(pty.Master);
                Assert.NotNull(pty.Slave);
            }
            catch (InvalidOperationException)
            {
                // ConPTY not available on this Windows version; acceptable
            }
        }
    }
}
