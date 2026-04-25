// <copyright file="ShellRunnerCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.Eventing;
using AiOrchestrator.Shell.Exceptions;
using AiOrchestrator.Shell.Temp;
using AiOrchestrator.Shell.Tests.Fakes;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Coverage-gap tests for ShellRunner, SecureTempScript, and exception constructors.</summary>
public sealed class ShellRunnerCoverageGapTests : IDisposable
{
    private readonly string tempDir;

    public ShellRunnerCoverageGapTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "shell-gap-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.tempDir, recursive: true); } catch { }
        GC.SuppressFinalize(this);
    }

    // ---- ShellRunner: argv for different shell kinds -----------------------

    [Fact]
    public async Task ShellRunner_Bash_UsesCorrectExecutableAndArgs()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.Bash, "echo hello");
        harness.Spawner.OnSpawn = h => h.Complete(0);

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        Assert.Equal("bash", processSpec.Executable);
        Assert.Single(processSpec.Arguments);
        Assert.EndsWith(".sh", processSpec.Arguments[0]);
    }

    [Fact]
    public async Task ShellRunner_Sh_UsesCorrectExecutableAndArgs()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.Sh, "echo hello");
        harness.Spawner.OnSpawn = h => h.Complete(0);

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        Assert.Equal("sh", processSpec.Executable);
        Assert.Single(processSpec.Arguments);
        Assert.EndsWith(".sh", processSpec.Arguments[0]);
    }

    [Fact]
    public async Task ShellRunner_Cmd_UsesCorrectExecutableAndArgs()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.Cmd, "echo hello");
        harness.Spawner.OnSpawn = h => h.Complete(0);

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        Assert.Equal("cmd.exe", processSpec.Executable);
        Assert.Contains("/d", processSpec.Arguments);
        Assert.Contains("/c", processSpec.Arguments);
        Assert.EndsWith(".cmd", processSpec.Arguments[^1]);
    }

    // ---- ShellRunner: stderr routing ---------------------------------------

    [Fact]
    public async Task ShellRunner_Stderr_RoutedToLineEvents()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: true);

        harness.Spawner.OnSpawn = h =>
        {
            _ = h.WriteStderrAsync(Encoding.UTF8.GetBytes("error line\n")).AsTask()
                .ContinueWith(_ => h.Complete(1), TaskScheduler.Default);
        };

        var result = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        Assert.Equal(1, result.ExitCode);
        Assert.True(result.StderrBytes > 0);
        var stderrEvents = harness.Bus.Published.OfType<ShellLineEmitted>()
            .Where(e => e.Stream == ShellStream.Stderr)
            .ToList();
        Assert.Single(stderrEvents);
        Assert.Equal("error line", stderrEvents[0].Line);
    }

    // ---- ShellRunner: no-capture mode --------------------------------------

    [Fact]
    public async Task ShellRunner_NoCaptureMode_DoesNotEmitLineEvents()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: false);

        harness.Spawner.OnSpawn = h =>
        {
            _ = h.WriteStdoutAsync(Encoding.UTF8.GetBytes("output\n")).AsTask()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        var result = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        Assert.Equal(0, result.ExitCode);
        Assert.True(result.StdoutBytes > 0);
        // No stdout line events should be emitted when capture is off.
        var stdoutLineEvents = harness.Bus.Published.OfType<ShellLineEmitted>()
            .Where(e => e.Stream == ShellStream.Stdout)
            .ToList();
        Assert.Empty(stdoutLineEvents);
    }

    // ---- ShellRunner: successful exit records byte counts -------------------

    [Fact]
    public async Task ShellRunner_ExitCode_PassedThrough()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec();

        harness.Spawner.OnSpawn = h => h.Complete(42);

        var result = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        Assert.Equal(42, result.ExitCode);
        Assert.False(result.TimedOut);
    }

    // ---- ShellRunner: null-guard tests -------------------------------------

    [Fact]
    public async Task ShellRunner_NullSpec_Throws()
    {
        var harness = new ShellRunnerHarness();
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await harness.Runner.RunAsync(null!, ShellRunnerHarness.SampleCtx(), CancellationToken.None));
    }

    [Fact]
    public async Task ShellRunner_NullCtx_Throws()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec();
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await harness.Runner.RunAsync(spec, null!, CancellationToken.None));
    }

    // ---- ShellRunner: partial line at end of stream -------------------------

    [Fact]
    public async Task ShellRunner_PartialLine_EmittedOnStreamEnd()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: true);

        harness.Spawner.OnSpawn = h =>
        {
            // Write data without trailing newline.
            _ = h.WriteStdoutAsync(Encoding.UTF8.GetBytes("no-newline")).AsTask()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var lines = harness.Bus.Published.OfType<ShellLineEmitted>()
            .Where(e => e.Stream == ShellStream.Stdout)
            .ToList();
        Assert.Single(lines);
        Assert.Equal("no-newline", lines[0].Line);
    }

    // ---- ShellRunner constructor null-guards --------------------------------

    [Fact]
    public void ShellRunner_NullSpawner_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(null!, new FakeFileSystem(), new Fakes.FakeClock(), new RecordingEventBus(),
                new TestOptionsMonitor<ShellOptions>(new ShellOptions()),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<ShellRunner>.Instance));
    }

    [Fact]
    public void ShellRunner_NullFileSystem_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(new FakeProcessSpawner(), null!, new Fakes.FakeClock(), new RecordingEventBus(),
                new TestOptionsMonitor<ShellOptions>(new ShellOptions()),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<ShellRunner>.Instance));
    }

    [Fact]
    public void ShellRunner_NullClock_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(new FakeProcessSpawner(), new FakeFileSystem(), null!, new RecordingEventBus(),
                new TestOptionsMonitor<ShellOptions>(new ShellOptions()),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<ShellRunner>.Instance));
    }

    [Fact]
    public void ShellRunner_NullBus_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(new FakeProcessSpawner(), new FakeFileSystem(), new Fakes.FakeClock(), null!,
                new TestOptionsMonitor<ShellOptions>(new ShellOptions()),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<ShellRunner>.Instance));
    }

    [Fact]
    public void ShellRunner_NullOpts_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(new FakeProcessSpawner(), new FakeFileSystem(), new Fakes.FakeClock(), new RecordingEventBus(),
                null!,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<ShellRunner>.Instance));
    }

    [Fact]
    public void ShellRunner_NullLogger_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ShellRunner(new FakeProcessSpawner(), new FakeFileSystem(), new Fakes.FakeClock(), new RecordingEventBus(),
                new TestOptionsMonitor<ShellOptions>(new ShellOptions()),
                null!));
    }

    // ---- SecureTempScript: invalid extension --------------------------------

    [Fact]
    public async Task SecureTempScript_InvalidExtension_NoLeadingDot_Throws()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var ex = await Assert.ThrowsAsync<ArgumentException>(async () =>
            await temp.CreateAsync(new byte[] { 1 }, "ps1", CancellationToken.None));
        Assert.Contains("extension", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SecureTempScript_NullExtension_Throws()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var ex = await Assert.ThrowsAsync<ArgumentException>(async () =>
            await temp.CreateAsync(new byte[] { 1 }, null!, CancellationToken.None));
        Assert.Contains("extension", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SecureTempScript_EmptyExtension_Throws()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var ex = await Assert.ThrowsAsync<ArgumentException>(async () =>
            await temp.CreateAsync(new byte[] { 1 }, string.Empty, CancellationToken.None));
        Assert.Contains("extension", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // ---- SecureTempScript: double-create ------------------------------------

    [Fact]
    public async Task SecureTempScript_DoubleCrate_Throws()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        _ = await temp.CreateAsync(new byte[] { 1 }, ".sh", CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await temp.CreateAsync(new byte[] { 2 }, ".sh", CancellationToken.None));
    }

    // ---- SecureTempScript: empty contents -----------------------------------

    [Fact]
    public async Task SecureTempScript_EmptyContents_Succeeds()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var path = await temp.CreateAsync(ReadOnlyMemory<byte>.Empty, ".sh", CancellationToken.None);

        Assert.True(File.Exists(path.Value));
        var bytes = File.ReadAllBytes(path.Value);
        Assert.Empty(bytes);
    }

    // ---- SecureTempScript: dispose without create is safe -------------------

    [Fact]
    public async Task SecureTempScript_DisposeWithoutCreate_IsSafe()
    {
        // Should not throw.
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
    }

    // ---- SecureTempScript: double-dispose is safe ---------------------------

    [Fact]
    public async Task SecureTempScript_DoubleDispose_IsSafe()
    {
        var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        _ = await temp.CreateAsync(Encoding.UTF8.GetBytes("test"), ".sh", CancellationToken.None);

        await temp.DisposeAsync();
        await temp.DisposeAsync(); // should not throw
    }

    // ---- SecureTempScript: Path property ------------------------------------

    [Fact]
    public async Task SecureTempScript_Path_NullBeforeCreate()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        Assert.Null(temp.Path);
    }

    [Fact]
    public async Task SecureTempScript_Path_SetAfterCreate()
    {
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var path = await temp.CreateAsync(new byte[] { 1 }, ".ps1", CancellationToken.None);
        Assert.NotNull(temp.Path);
        Assert.Equal(path, temp.Path);
    }

    // ---- WorkingDirectoryNotFoundException constructors ---------------------

    [Fact]
    public void WorkingDirectoryNotFoundException_DefaultCtor()
    {
        var ex = new WorkingDirectoryNotFoundException();
        Assert.NotNull(ex.Message);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_MessageCtor()
    {
        var ex = new WorkingDirectoryNotFoundException("custom msg");
        Assert.Equal("custom msg", ex.Message);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_MessageAndInnerCtor()
    {
        var inner = new IOException("inner");
        var ex = new WorkingDirectoryNotFoundException("outer", inner);
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_PathCtor()
    {
        var path = new AbsolutePath("/missing/dir");
        var ex = new WorkingDirectoryNotFoundException(path);
        Assert.Equal(path, ex.WorkingDirectory);
        Assert.Contains("/missing/dir", ex.Message);
    }

    // ---- ShellRunner: Windows CR/LF stripping ------------------------------

    [Fact]
    public async Task ShellRunner_WindowsLineEndings_StrippedCorrectly()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: true);

        harness.Spawner.OnSpawn = h =>
        {
            _ = h.WriteStdoutAsync(Encoding.UTF8.GetBytes("line1\r\nline2\r\n")).AsTask()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var lines = harness.Bus.Published.OfType<ShellLineEmitted>()
            .Where(e => e.Stream == ShellStream.Stdout)
            .Select(e => e.Line)
            .ToArray();

        Assert.Equal(new[] { "line1", "line2" }, lines);
    }
}
