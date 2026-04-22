// <copyright file="TestInfrastructure.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Options;
using Xunit;
using IAuditLog = AiOrchestrator.Audit.IAuditLog;

namespace AiOrchestrator.Daemon.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    private T value;

    public StaticOptionsMonitor(T value) => this.value = value;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable? OnChange(Action<T, string?> listener) => null;

    public void Set(T newValue) => this.value = newValue;
}

public sealed class InMemoryAuditLog : IAuditLog
{
    public List<AuditRecord> Records { get; } = new();

    public ValueTask AppendAsync(AuditRecord record, CancellationToken ct)
    {
        lock (this.Records)
        {
            this.Records.Add(record);
        }

        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<AuditRecord> ReadAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        List<AuditRecord> snap;
        lock (this.Records)
        {
            snap = new List<AuditRecord>(this.Records);
        }

        foreach (var r in snap)
        {
            yield return r;
        }

        await Task.CompletedTask;
    }

    public ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct) =>
        ValueTask.FromResult(new ChainVerification { Ok = true });
}

public sealed class InMemoryEventBus : IEventBus
{
    public List<object> Published { get; } = new();

    public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
        where TEvent : notnull
    {
        lock (this.Published)
        {
            this.Published.Add(eventData);
        }

        return ValueTask.CompletedTask;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
        => new NullSub();

    private sealed class NullSub : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

public sealed class FakeClock : IClock
{
    public DateTimeOffset UtcNow { get; set; } = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public long MonotonicMilliseconds { get; set; } = 1000;
}

public sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    public ConcurrentDictionary<string, byte[]> Responses { get; } = new(StringComparer.Ordinal);

    public Func<string, HttpResponseMessage>? Override { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var url = request.RequestUri!.ToString();
        if (this.Override is { } over)
        {
            return Task.FromResult(over(url));
        }

        if (this.Responses.TryGetValue(url, out var body))
        {
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(body),
            });
        }

        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}

public sealed class FakeHttpClientFactory : IHttpClientFactory
{
    private readonly FakeHttpMessageHandler handler;

    public FakeHttpClientFactory(FakeHttpMessageHandler handler) => this.handler = handler;

    public HttpClient CreateClient(string name) => new(this.handler, disposeHandler: false);
}

public sealed class InMemoryFileSystem : IFileSystem
{
    public ConcurrentDictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);

    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(this.Files.ContainsKey(path.Value));

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
    {
        if (this.Files.TryGetValue(path.Value, out var b))
        {
            return ValueTask.FromResult(System.Text.Encoding.UTF8.GetString(b));
        }

        throw new FileNotFoundException(path.Value);
    }

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        this.Files[path.Value] = System.Text.Encoding.UTF8.GetBytes(contents);
        return ValueTask.CompletedTask;
    }

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult<Stream>(new MemoryStream(this.Files[path.Value], writable: false));

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
    {
        var ms = new MemoryStream();
        this.Files[path.Value] = Array.Empty<byte>();
        return ValueTask.FromResult<Stream>(ms);
    }

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        if (this.Files.TryRemove(source.Value, out var b))
        {
            this.Files[destination.Value] = b;
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        this.Files.TryRemove(path.Value, out _);
        return ValueTask.CompletedTask;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(MountKind.Local);
}

public static class TestPrincipals
{
    public static AuthContext Anyone() => new()
    {
        PrincipalId = "anyone",
        DisplayName = "Anyone",
        Scopes = ImmutableArray.Create("daemon"),
        IssuedAtUtc = DateTimeOffset.UnixEpoch,
    };
}
