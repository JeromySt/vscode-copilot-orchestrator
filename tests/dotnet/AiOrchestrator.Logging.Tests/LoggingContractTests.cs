// <copyright file="LoggingContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Text.Json;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Logging;
using AiOrchestrator.Logging.Telemetry;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Logging.Tests;

/// <summary>Marks a test as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initialises a new instance with the given acceptance criterion ID.</summary>
    /// <param name="id">The acceptance criterion identifier (e.g., "LOG-1").</param>
    public ContractTestAttribute(string id) => Id = id;

    /// <summary>Gets the acceptance criterion ID.</summary>
    public string Id { get; }
}

/// <summary>Contract tests for the AiOrchestrator.Logging module.</summary>
public sealed class LoggingContractTests
{
    // -------------------------------------------------------------------------
    // CompactJsonFormatter Tests
    // -------------------------------------------------------------------------

    [Fact]
    [ContractTest("LOG-1")]
    public void LOG_1_EmitsSingleLineJsonPerEntry()
    {
        // Arrange
        var formatter = BuildFormatter();
        using var writer = new StringWriter();
        var entry = MakeEntry("Test message");

        // Act
        formatter.Write(in entry, null, writer);

        // Assert
        var output = writer.ToString();
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        lines.Should().HaveCount(1, "exactly one JSON line must be emitted per log entry");
        var doc = JsonDocument.Parse(lines[0]);
        doc.RootElement.ValueKind.Should().Be(JsonValueKind.Object, "the single line must be a JSON object");
    }

    [Fact]
    [ContractTest("LOG-2")]
    public void LOG_2_IncludesRequiredFields()
    {
        // Arrange
        var formatter = BuildFormatter();
        using var writer = new StringWriter();
        var entry = MakeEntry("Hello World", category: "MyCategory");

        // Act
        formatter.Write(in entry, null, writer);

        // Assert
        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        json.TryGetProperty("timestamp", out _).Should().BeTrue("timestamp is required (INV-2)");
        json.TryGetProperty("level", out _).Should().BeTrue("level is required (INV-2)");
        json.TryGetProperty("category", out var cat).Should().BeTrue("category is required (INV-2)");
        json.TryGetProperty("message", out var msg).Should().BeTrue("message is required (INV-2)");
        cat.GetString().Should().Be("MyCategory");
        msg.GetString().Should().Be("Hello World");
    }

    [Fact]
    [ContractTest("LOG-3")]
    public void LOG_3_AppliesRedactor_BeforeWrite()
    {
        // Arrange
        var redactor = new PrefixRedactor("[REDACTED]");
        var formatter = BuildFormatter(redactor: redactor);
        using var writer = new StringWriter();
        var entry = MakeEntry("Secret: password123");

        // Act
        formatter.Write(in entry, null, writer);

        // Assert — the redactor must have been applied
        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        json.GetProperty("message").GetString().Should()
            .StartWith("[REDACTED]", "IRedactor must be applied to the message before writing (INV-3)");
    }

    [Fact]
    [ContractTest("LOG-8")]
    public void LOG_8_FormatterException_EmitsFallbackAndRethrows()
    {
        // Arrange — a redactor that always throws
        var formatter = BuildFormatter(redactor: new ThrowingRedactor());
        using var writer = new StringWriter();
        var entry = MakeEntry("This will cause the redactor to throw");

        // Act + Assert
        var act = () => formatter.Write(in entry, null, writer);
        act.Should().Throw<InvalidOperationException>("the formatter must rethrow after writing the fallback (INV-8)");

        var output = writer.ToString();
        output.Should().Contain("LoggerFormatterFailure", "the fallback line must mention LoggerFormatterFailure (INV-8)");
    }

    // -------------------------------------------------------------------------
    // AmbientContext Tests
    // -------------------------------------------------------------------------

    [Fact]
    [ContractTest("LOG-4")]
    public async Task LOG_4_AmbientContext_FlowsAcrossAwait()
    {
        // Arrange
        const string key = "correlationId";
        const string value = "abc-123";

        // Act
        using var scope = AmbientContext.Push(key, value);

        // Await a yield to verify AsyncLocal flows across continuation
        await Task.Yield();

        var result = AmbientContext.Get<string>(key);

        // Assert
        result.Should().Be(value, "AmbientContext must flow across await continuations (INV-4)");
    }

    [Fact]
    [ContractTest("LOG-5")]
    public void LOG_5_AmbientContext_RestoredOnDispose()
    {
        // Arrange — push a base value
        const string key = "requestId";
        using var outerScope = AmbientContext.Push(key, "outer");

        // Act — push an inner value
        using (AmbientContext.Push(key, "inner"))
        {
            AmbientContext.Get<string>(key).Should().Be("inner", "inner value must be visible inside its scope");
        }

        // Assert — outer value is restored after inner scope is disposed
        AmbientContext.Get<string>(key).Should()
            .Be("outer", "the prior snapshot must be restored atomically on Dispose (INV-4)");
    }

    [Fact]
    [ContractTest("LOG-6")]
    public async Task LOG_6_AmbientContext_DoesNotLeakAcrossTests()
    {
        // Simulate a "leaky" child execution context that forgets to clean up.
        // AsyncLocal values modified by a child task must NOT propagate back to the parent.
        const string leakKey = "leak-isolation-key";

        await Task.Run(() =>
        {
            // Set value in child context without disposing (simulating a leak-prone test)
            _ = AmbientContext.Push(leakKey, "leaked-value");

            // Do NOT dispose — value "leaks" within this execution context
            // but should not propagate to the parent context.
        });

        // Assert — parent execution context must not see the child's modification
        AmbientContext.Get<string>(leakKey).Should()
            .BeNull("AsyncLocal modifications in child tasks must not leak to the parent context (INV-5)");
    }

    // -------------------------------------------------------------------------
    // OtlpTelemetrySink Tests
    // -------------------------------------------------------------------------

    [Fact]
    [ContractTest("LOG-7")]
    public void LOG_7_OtlpDisabled_IsZeroAllocation()
    {
        // Arrange
        var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = false }));

        // Warm up JIT to eliminate first-call allocation noise
        sink.RecordCounter("warmup", 1);
        sink.RecordHistogram("warmup", 1.0);
        using (sink.StartActivity("warmup")) { }

        // Act — measure allocations for the three disabled paths
        var before = GC.GetAllocatedBytesForCurrentThread();
        sink.RecordCounter("test.counter", 1, null);
        sink.RecordHistogram("test.histogram", 1.0, null);
        using (sink.StartActivity("test.activity", null)) { }
        var after = GC.GetAllocatedBytesForCurrentThread();

        // Assert — zero bytes allocated (INV-6)
        (after - before).Should().Be(0, "disabled OTLP sink must not allocate on any Record* path (INV-6)");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static CompactJsonFormatter BuildFormatter(
        CompactJsonFormatterOptions? options = null,
        IRedactor? redactor = null)
    {
        var opts = options ?? new CompactJsonFormatterOptions { IncludeScopes = false };
        var monitor = new StaticOptionsMonitor<CompactJsonFormatterOptions>(opts);
        return new CompactJsonFormatter(monitor, redactor ?? new PassThroughRedactor());
    }

    private static LogEntry<string> MakeEntry(
        string message,
        LogLevel level = LogLevel.Information,
        string category = "TestCategory")
    {
        return new LogEntry<string>(
            level,
            category,
            default,
            message,
            exception: null,
            formatter: static (s, _) => s);
    }

    // -------------------------------------------------------------------------
    // Test doubles
    // -------------------------------------------------------------------------

    private sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    {
        private readonly T _value;

        internal StaticOptionsMonitor(T value) => _value = value;

        public T CurrentValue => _value;

        public T Get(string? name) => _value;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    private sealed class PassThroughRedactor : IRedactor
    {
        public string Redact(string input) => input;

        public ValueTask<int> RedactAsync(
            ReadOnlySequence<byte> input,
            IBufferWriter<byte> output,
            CancellationToken ct) => ValueTask.FromResult(0);
    }

    private sealed class PrefixRedactor : IRedactor
    {
        private readonly string _prefix;

        internal PrefixRedactor(string prefix) => _prefix = prefix;

        public string Redact(string input) => _prefix + input;

        public ValueTask<int> RedactAsync(
            ReadOnlySequence<byte> input,
            IBufferWriter<byte> output,
            CancellationToken ct) => ValueTask.FromResult(0);
    }

    private sealed class ThrowingRedactor : IRedactor
    {
        public string Redact(string input) =>
            throw new InvalidOperationException("Redactor failure (test)");

        public ValueTask<int> RedactAsync(
            ReadOnlySequence<byte> input,
            IBufferWriter<byte> output,
            CancellationToken ct) => ValueTask.FromResult(0);
    }
}
