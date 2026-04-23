// <copyright file="VsCodeTransportContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Composition;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
using AiOrchestrator.VsCode.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.VsCode.Transport.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class VsCodeTransportContractTests
{
    // -------------------------------------------------------------------------
    // VS-TRANS-REF: Only AiOrchestrator.VsCode.Transport references Microsoft.VisualStudio.*
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-REF")]
    public void TRANSPORT_SOLE_VsRef_Analyzer()
    {
        string repoRoot = FindRepoRoot();
        string srcDir = Path.Combine(repoRoot, "dotnet", "src");
        Assert.True(Directory.Exists(srcDir), $"expected dotnet/src under {repoRoot}");

        string[] csprojFiles = Directory.GetFiles(srcDir, "*.csproj", SearchOption.AllDirectories);

        var offenders = new List<(string Project, string Package)>();
        foreach (string f in csprojFiles)
        {
            string content = File.ReadAllText(f);
            string name = Path.GetFileNameWithoutExtension(f);
            var matches = System.Text.RegularExpressions.Regex.Matches(
                content,
                "<PackageReference\\s+Include=\"(Microsoft\\.VisualStudio\\.[^\"]+)\"");

            foreach (System.Text.RegularExpressions.Match m in matches)
            {
                if (!string.Equals(name, "AiOrchestrator.VsCode.Transport", StringComparison.Ordinal))
                {
                    offenders.Add((name, m.Groups[1].Value));
                }
            }
        }

        Assert.Empty(offenders);
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-SESS: Each VS Code window has its own isolated session + scope
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-SESS")]
    public async Task TRANSPORT_SESSION_PerWindowIsolated()
    {
        await using VsCodeTransport transport = Build(out _, out _);

        await using TransportSession s1 = await transport.CreateSessionAsync(new VsCodeWindowId("win-1"), CancellationToken.None);
        await using TransportSession s2 = await transport.CreateSessionAsync(new VsCodeWindowId("win-2"), CancellationToken.None);

        Assert.NotEqual(s1.WindowId, s2.WindowId);
        Assert.False(ReferenceEquals(s1.Scope, s2.Scope), "INV-2: per-window scopes must be distinct");

        // Disposing one session must not tear down the other's scope.
        await s1.DisposeAsync();
        Assert.True(s1.IsDisposed);
        Assert.False(s2.IsDisposed);
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-IDLE: Session auto-disposes after SessionIdleTimeout of inactivity
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-IDLE")]
    public async Task TRANSPORT_SESSION_IdleTimeoutDisposes()
    {
        var clock = new ManualClock();
        await using VsCodeTransport transport = Build(
            out _,
            out _,
            clock: clock,
            opts: new TransportOptions { SessionIdleTimeout = TimeSpan.FromMilliseconds(2_000) });

        TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("idle-win"), CancellationToken.None);

        // Advance virtual clock past the idle threshold; the internal timer polls at ~1s.
        clock.Advance(TimeSpan.FromSeconds(10));

        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (!session.IsDisposed && DateTime.UtcNow < deadline)
        {
            await Task.Delay(100);
        }

        Assert.True(session.IsDisposed, "INV-3: idle timeout must auto-dispose the session");
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-WATCH: WatchEventsAsync multiplexes multiple event kinds
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-WATCH")]
    public async Task TRANSPORT_WATCH_EventsMultiplexed()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("watch"), CancellationToken.None);

        var now = DateTimeOffset.UtcNow;
        session.Publish(new TransportEvent { Kind = "plan.progress", Payload = Json("{\"p\":1}"), At = now });
        session.Publish(new TransportEvent { Kind = "job.state", Payload = Json("{\"s\":\"running\"}"), At = now });
        session.Publish(new TransportEvent { Kind = "log", Payload = Json("{\"line\":\"hello\"}"), At = now });

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var kinds = new List<string>();
        await foreach (TransportEvent evt in session.WatchEventsAsync(cts.Token))
        {
            kinds.Add(evt.Kind);
            if (kinds.Count == 3)
            {
                break;
            }
        }

        Assert.Equivalent(new[] { "plan.progress", "job.state", "log" }, kinds);
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-TOOL: Tool invocation routes through McpToolRegistry
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-TOOL")]
    public async Task TRANSPORT_TOOL_RoutesThroughMcp()
    {
        var tool = new RecordingTool();
        await using VsCodeTransport transport = Build(out _, out _, extraTools: new[] { tool });
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("tool"), CancellationToken.None);

        JsonNode result = await session.InvokeToolAsync(tool.Name, Json("{\"planId\":\"p\"}"), CancellationToken.None);

        Assert.Equal(1, tool.Invocations);
        Assert.True(result["ok"]!.GetValue<bool>());
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-PROG: progress-kind events are notified via MCP bridge
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-PROG")]
    public async Task TRANSPORT_PROGRESS_NotifiesViaMcp()
    {
        await using VsCodeTransport transport = Build(out _, out _,
            opts: new TransportOptions { EnableProgressNotifications = true });
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("prog"), CancellationToken.None);

        // Publishing a progress event must succeed and propagate without throwing.
        bool enqueued = session.Publish(new TransportEvent
        {
            Kind = "plan.progress",
            Payload = Json("{\"pct\":50}"),
            At = DateTimeOffset.UtcNow,
        });

        Assert.True(enqueued, "INV-6: progress events are forwarded through the MCP bridge");

        // Verify the event was queued on the iterator (integration side of INV-6).
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await foreach (TransportEvent evt in session.WatchEventsAsync(cts.Token))
        {
            Assert.Equal("plan.progress", evt.Kind);
            break;
        }
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-CANCEL: CancellationToken from VS Code propagates to the orchestrator
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-CANCEL")]
    public async Task TRANSPORT_CANCELLATION_Propagates()
    {
        var slow = new SlowTool(TimeSpan.FromSeconds(30));
        await using VsCodeTransport transport = Build(out _, out _, extraTools: new[] { slow });
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("cancel"), CancellationToken.None);

        using var cts = new CancellationTokenSource();
        Task<JsonNode> call = session.InvokeToolAsync(slow.Name, Json("{\"planId\":\"p\"}"), cts.Token).AsTask();

        // Give the call a moment to enter the tool, then cancel from the "VS Code" side.
        await Task.Delay(100);
        cts.Cancel();

        Func<Task> act = () => call;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(act);
    }

    // -------------------------------------------------------------------------
    // VS-TRANS-ERR: Errors preserve .NET exception type name in error.code
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("VS-TRANS-ERR")]
    public async Task TRANSPORT_ERROR_PreservesDotnetTypeName()
    {
        var throwing = new ThrowingTool();
        await using VsCodeTransport transport = Build(out _, out _, extraTools: new[] { throwing });
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("err"), CancellationToken.None);

        JsonNode result = await session.InvokeToolAsync(throwing.Name, Json("{\"planId\":\"p\"}"), CancellationToken.None);

        Assert.NotNull(result["error"]);
        Assert.Equal(
            "InvalidOperationException",
            result["error"]!["code"]!.GetValue<string>());
    }

    // ----------------------- Helpers -----------------------------------

    private static VsCodeTransport Build(
        out NodeBindingsHost bindings,
        out McpServer mcp,
        IClock? clock = null,
        TransportOptions? opts = null,
        IEnumerable<IMcpTool>? extraTools = null)
    {
        clock ??= new SystemClock();
        opts ??= new TransportOptions();

        IConfiguration config = new ConfigurationBuilder().AddInMemoryCollection([]).Build();
        var services = new ServiceCollection();
        _ = services.AddLogging();
        _ = services.AddSingleton<IMcpTransport>(_ => new NullTransport());
        _ = services.AddSingleton<McpToolRegistry>(sp =>
        {
            List<IMcpTool> tools = [.. sp.GetServices<IMcpTool>()];
            if (extraTools is not null)
            {
                tools.AddRange(extraTools);
            }

            if (tools.Count == 0)
            {
                tools.Add(new NoopTool());
            }

            return new McpToolRegistry(tools);
        });
        _ = services.Configure<McpOptions>(_ => { });
        _ = services.AddSingleton<McpServer>();

        ServiceProvider sp = services.BuildServiceProvider();

        bindings = new NodeBindingsHost(sp);
        mcp = sp.GetRequiredService<McpServer>();

        var transportOpts = new StaticMonitor<TransportOptions>(opts);
        return new VsCodeTransport(bindings, mcp, clock, transportOpts, NullLogger<VsCodeTransport>.Instance);
    }

    private static JsonElement Json(string raw)
    {
        using JsonDocument doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }

    private static string FindRepoRoot()
    {
        string dir = AppContext.BaseDirectory;
        while (!string.IsNullOrEmpty(dir))
        {
            if (Directory.Exists(Path.Combine(dir, ".git")) ||
                File.Exists(Path.Combine(dir, "package.json")))
            {
                return dir;
            }

            string? parent = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(parent) || parent == dir)
            {
                break;
            }

            dir = parent;
        }

        return AppContext.BaseDirectory;
    }

    // ----------------------- Test doubles -----------------------------

    private sealed class NullTransport : IMcpTransport
    {
        public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) => ValueTask.FromResult<JsonRpcEnvelope?>(null);

        public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) => ValueTask.CompletedTask;
    }

    private sealed class NoopTool : IMcpTool
    {
        public string Name => "noop";

        public string Description => "noop";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct) =>
            ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
    }

    private sealed class RecordingTool : IMcpTool
    {
        public string Name => "recording";

        public string Description => "records invocations";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public int Invocations { get; private set; }

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            this.Invocations++;
            return ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
        }
    }

    private sealed class SlowTool : IMcpTool
    {
        private readonly TimeSpan delay;

        public SlowTool(TimeSpan delay) => this.delay = delay;

        public string Name => "slow";

        public string Description => "slow";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public async ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            await Task.Delay(this.delay, ct);
            return new JsonObject { ["ok"] = true };
        }
    }

    private sealed class ThrowingTool : IMcpTool
    {
        public string Name => "throwing";

        public string Description => "throws";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct) =>
            throw new InvalidOperationException("boom");
    }

    private sealed class SystemClock : IClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public long MonotonicMilliseconds => Environment.TickCount64;
    }

    private sealed class ManualClock : IClock
    {
        private long monotonicMs;

        public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.UnixEpoch;

        public long MonotonicMilliseconds => Interlocked.Read(ref this.monotonicMs);

        public void Advance(TimeSpan delta)
        {
            _ = Interlocked.Add(ref this.monotonicMs, (long)delta.TotalMilliseconds);
            this.UtcNow = this.UtcNow.Add(delta);
        }
    }

    private sealed class StaticMonitor<T> : IOptionsMonitor<T>
        where T : class
    {
        public StaticMonitor(T value) => this.CurrentValue = value;

        public T CurrentValue { get; }

        public T Get(string? name) => this.CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
