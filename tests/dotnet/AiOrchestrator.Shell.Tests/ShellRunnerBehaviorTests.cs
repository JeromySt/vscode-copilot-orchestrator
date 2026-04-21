// <copyright file="ShellRunnerBehaviorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.Eventing;
using AiOrchestrator.Shell.Exceptions;
using AiOrchestrator.Shell.Tests.Fakes;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Behavioural contract tests for timeout, line-routing, and working-directory validation.</summary>
public class ShellRunnerBehaviorTests
{
    [Fact]
    [ContractTest("SHELL-TIMEOUT")]
    public async Task SHELL_TIMEOUT_KillsAfterGracePeriod()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(timeout: TimeSpan.FromMilliseconds(50));

        // Fake handle never completes on its own — runner must escalate via SIGTERM then SIGKILL.
        // (FakeProcessHandle.SignalAsync(Kill) auto-completes with exit code -1.)
        var result = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        result.TimedOut.Should().BeTrue();
        var handle = harness.Spawner.SpawnedHandles.Single();
        handle.SignalsSent.Should().Contain(ProcessSignal.Terminate, "INV-9 mandates SIGTERM first");

        // Either the process exited within grace (no SIGKILL) or SIGKILL was sent.
        // The fake handle never voluntarily exits, so SIGKILL must have been sent.
        handle.SignalsSent.Should().Contain(ProcessSignal.Kill, "INV-9 mandates SIGKILL after grace period");
    }

    [Fact]
    [ContractTest("SHELL-STDOUT")]
    public async Task SHELL_STDOUT_RoutesToLineProjector()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: true);

        harness.Spawner.OnSpawn = h =>
        {
            // Emit two lines on stdout, then complete.
            _ = h.WriteStdoutAsync(Encoding.UTF8.GetBytes("hello\nworld\n")).AsTask()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var lineEvents = harness.Bus.Published.OfType<ShellLineEmitted>().ToList();
        lineEvents.Select(e => e.Line).Should().ContainInOrder("hello", "world");
        lineEvents.Should().OnlyContain(e => e.Stream == ShellStream.Stdout);
    }

    [Fact]
    [ContractTest("SHELL-WD")]
    public async Task SHELL_WD_NotFoundThrows()
    {
        var harness = new ShellRunnerHarness();

        // Note: we do NOT register the working directory in the FakeFileSystem.ExistingPaths set.
        var nonexistent = new AbsolutePath(Path.Combine(Path.GetTempPath(), "definitely-does-not-exist-" + Guid.NewGuid().ToString("N")));

        var spec = new ShellSpec
        {
            Shell = ShellKind.Bash,
            Script = "echo hi",
            WorkingDirectory = nonexistent,
            Env = System.Collections.Immutable.ImmutableDictionary<string, string>.Empty,
        };

        Func<Task> act = async () => await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<WorkingDirectoryNotFoundException>();
        ex.Which.WorkingDirectory.Should().Be(nonexistent);
    }
}
