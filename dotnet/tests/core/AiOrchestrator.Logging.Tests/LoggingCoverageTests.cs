// <copyright file="LoggingCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Diagnostics;
using System.Text.Json;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Logging;
using AiOrchestrator.Logging.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Logging.Tests;

/// <summary>Additional coverage tests for the AiOrchestrator.Logging module.</summary>
public sealed class LoggingCoverageTests
{
    // -------------------------------------------------------------------------
    // CompactJsonFormatter — additional coverage
    // -------------------------------------------------------------------------

    [Fact]
    public void Write_WithException_IncludesExceptionField()
    {
        var formatter = BuildFormatter();
        using var writer = new StringWriter();
        var ex = new InvalidOperationException("boom");
        var entry = new LogEntry<string>(
            LogLevel.Error,
            "Cat",
            default,
            "msg",
            exception: ex,
            formatter: static (s, _) => s);

        formatter.Write(in entry, null, writer);

        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        Assert.True(json.TryGetProperty("exception", out _));
    }

    [Fact]
    public void Write_WithActiveActivity_IncludesTraceIdAndSpanId()
    {
        var source = new ActivitySource("LoggingTests.Write");
        using var listener = new ActivityListener
        {
            ShouldListenTo = _ => true,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
        };
        ActivitySource.AddActivityListener(listener);

        using var activity = source.StartActivity("test");

        var formatter = BuildFormatter();
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");
        formatter.Write(in entry, null, writer);

        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        Assert.True(json.TryGetProperty("traceId", out _));
        Assert.True(json.TryGetProperty("spanId", out _));
    }

    [Fact]
    public void Write_WithIncludeScopes_AndIEnumerableScope_IncludesScopeProperties()
    {
        var opts = new CompactJsonFormatterOptions { IncludeScopes = true };
        var formatter = BuildFormatter(options: opts);
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");
        var scopeProps = new Dictionary<string, object?> { ["reqId"] = "r1" };
        var scopeProvider = new SingleScopeProvider(scopeProps);

        formatter.Write(in entry, scopeProvider, writer);

        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        Assert.True(json.TryGetProperty("reqId", out _));
    }

    [Fact]
    public void Write_WithIncludeScopes_AndNonEnumerableScope_IsSkipped()
    {
        var opts = new CompactJsonFormatterOptions { IncludeScopes = true };
        var formatter = BuildFormatter(options: opts);
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");
        // Non-IEnumerable<KeyValuePair<string, object?>> scope (plain string object)
        var scopeProvider = new SingleScopeProvider("plain-string-scope");

        formatter.Write(in entry, scopeProvider, writer);

        // Should still produce valid JSON — non-IEnumerable scopes are silently skipped
        JsonDocument.Parse(writer.ToString().Trim());
    }

    [Fact]
    public void Write_WithIncludeScopesTrue_AndNullScopeProvider_ProducesValidJson()
    {
        var opts = new CompactJsonFormatterOptions { IncludeScopes = true };
        var formatter = BuildFormatter(options: opts);
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");

        formatter.Write(in entry, null, writer);

        JsonDocument.Parse(writer.ToString().Trim());
    }

    [Fact]
    public void Write_WithAmbientContextSet_IncludesContextKey()
    {
        using var ctx = AmbientContext.Push("ambient-key", "ambient-val");
        var formatter = BuildFormatter();
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");

        formatter.Write(in entry, null, writer);

        var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
        Assert.True(json.TryGetProperty("ambient-key", out var val));
        Assert.Equal("ambient-val", val.GetString());
    }

    [Fact]
    public void Write_IndentedJson_ProducesValidJson()
    {
        var opts = new CompactJsonFormatterOptions { IndentJson = true };
        var formatter = BuildFormatter(options: opts);
        using var writer = new StringWriter();
        var entry = MakeEntry("msg");

        formatter.Write(in entry, null, writer);

        JsonDocument.Parse(writer.ToString());
    }

    [Fact]
    public void Write_AllLogLevels_EmitCorrectLevelStrings()
    {
        var formatter = BuildFormatter();
        var cases = new[]
        {
            (LogLevel.Trace, "Trace"),
            (LogLevel.Debug, "Debug"),
            (LogLevel.Warning, "Warning"),
            (LogLevel.Error, "Error"),
            (LogLevel.Critical, "Critical"),
            (LogLevel.None, "None"),
        };

        foreach (var (level, expected) in cases)
        {
            using var writer = new StringWriter();
            var entry = MakeEntry("msg", level: level);
            formatter.Write(in entry, null, writer);
            var json = JsonDocument.Parse(writer.ToString().Trim()).RootElement;
            Assert.Equal(expected, json.GetProperty("level").GetString());
        }
    }

    [Fact]
    public void Dispose_CompactJsonFormatter_DoesNotThrow()
    {
        var formatter = BuildFormatter();
        formatter.Dispose();
    }

    // -------------------------------------------------------------------------
    // OtlpTelemetrySink — enabled paths
    // -------------------------------------------------------------------------

    [Fact]
    public void RecordCounter_Enabled_WithTags_DoesNotThrow()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));
        var tags = new Dictionary<string, object> { ["env"] = "test" };

        sink.RecordCounter("my.counter", 5L, tags);
    }

    [Fact]
    public void RecordCounter_Enabled_NullTags_DoesNotThrow()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));

        sink.RecordCounter("my.counter", 1L, null);
    }

    [Fact]
    public void RecordHistogram_Enabled_WithTags_DoesNotThrow()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));
        var tags = new Dictionary<string, object> { ["env"] = "test" };

        sink.RecordHistogram("my.histogram", 3.14, tags);
    }

    [Fact]
    public void RecordHistogram_Enabled_NullTags_DoesNotThrow()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));

        sink.RecordHistogram("my.histogram", 0.5, null);
    }

    [Fact]
    public void StartActivity_Enabled_NullTags_ReturnsDisposable()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));

        using var handle = sink.StartActivity("my.span", null);
        Assert.NotNull(handle);
    }

    [Fact]
    public void StartActivity_Enabled_WithTags_ReturnsDisposable()
    {
        using var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));
        var tags = new Dictionary<string, object> { ["k"] = "v" };

        using var handle = sink.StartActivity("my.span", tags);
        Assert.NotNull(handle);
    }

    [Fact]
    public void Dispose_Enabled_DoesNotThrow()
    {
        var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = true }));
        sink.Dispose();
    }

    [Fact]
    public void Dispose_Disabled_DoesNotThrow()
    {
        var sink = new OtlpTelemetrySink(Options.Create(new OtlpOptions { Enabled = false }));
        sink.Dispose();
    }

    // -------------------------------------------------------------------------
    // AmbientContext — additional coverage
    // -------------------------------------------------------------------------

    [Fact]
    public void AmbientContext_Restorer_DoubleDispose_IsIdempotent()
    {
        var restorer = AmbientContext.Push("k", "v");
        restorer.Dispose();

        // Second dispose must not throw (tests the `if (this.disposed) return;` guard)
        restorer.Dispose();
    }

    [Fact]
    public void AmbientContext_Get_WithWrongType_ReturnsDefault()
    {
        using var _ = AmbientContext.Push("typed-key", 42); // int value
        var result = AmbientContext.Get<string>("typed-key"); // requesting string
        Assert.Null(result);
    }

    [Fact]
    public async Task AmbientContext_Push_WhenCurrentIsNull_StartsFreshDictionary()
    {
        // Run in a fresh Task to ensure Current is null initially
        await Task.Run(() =>
        {
            // No prior Push — Current.Value is null
            using var scope = AmbientContext.Push("fresh-key", "fresh-val");
            var result = AmbientContext.Get<string>("fresh-key");
            Assert.Equal("fresh-val", result);
        });
    }

    // -------------------------------------------------------------------------
    // LoggerCategory
    // -------------------------------------------------------------------------

    [Fact]
    public void LoggerCategory_Name_ReturnsFullTypeName()
    {
        var name = LoggerCategory<LoggingCoverageTests>.Name;
        Assert.Equal(typeof(LoggingCoverageTests).FullName, name);
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
        private readonly T value;

        internal StaticOptionsMonitor(T val) => this.value = val;

        public T CurrentValue => this.value;

        public T Get(string? name) => this.value;

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

    private sealed class SingleScopeProvider : IExternalScopeProvider
    {
        private readonly object? scope;

        internal SingleScopeProvider(object? scope) => this.scope = scope;

        public void ForEachScope<TState>(Action<object?, TState> callback, TState state)
        {
            callback(this.scope, state);
        }

        public IDisposable Push(object? state) => new NopDisposable();

        private sealed class NopDisposable : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }
}
