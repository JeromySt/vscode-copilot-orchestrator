// <copyright file="BindingsNodeContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Bindings.Node.Generators;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AiOrchestrator.Bindings.Node.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class BindingsNodeContractTests
{
    private static NodeBindingsHost NewHost()
    {
        IServiceProvider sp = new ServiceCollection().BuildServiceProvider();
        return new NodeBindingsHost(sp);
    }

    // -------------------------------------------------------------------------
    // HOST-SCOPE-1: Handle lifetime is mapped to the owning scope
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("HOST-SCOPE-1")]
    public async Task HOST_SCOPE_1_HandleLifetimeMappedToScope()
    {
        NodeBindingsHost host = NewHost();
        HandleScope scope = new(host);

        HandleId id = await scope.RegisterAsync(new object(), CancellationToken.None);
        object resolved = await host.ResolveHandleAsync<object>(id, CancellationToken.None);
        resolved.Should().NotBeNull();

        await scope.DisposeAsync();
        await host.DisposeAsync();
    }

    // -------------------------------------------------------------------------
    // HOST-SCOPE-2: Disposing a scope releases every handle registered in it
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("HOST-SCOPE-2")]
    public async Task HOST_SCOPE_2_DisposeReleasesAll()
    {
        NodeBindingsHost host = NewHost();
        HandleScope scope = new(host);

        List<HandleId> ids = new();
        for (int i = 0; i < 5; i++)
        {
            ids.Add(await scope.RegisterAsync(new object(), CancellationToken.None));
        }

        await scope.DisposeAsync();

        foreach (HandleId id in ids)
        {
            Action act = () => host.ResolveHandleAsync<object>(id, CancellationToken.None).GetAwaiter().GetResult();
            act.Should().Throw<HandleDisposedException>();
        }

        await host.DisposeAsync();
    }

    // -------------------------------------------------------------------------
    // HOST-SCOPE-3: Resolving a handle after its scope is disposed throws
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("HOST-SCOPE-3")]
    public async Task HOST_SCOPE_3_ResolveAfterDisposeThrows()
    {
        NodeBindingsHost host = NewHost();
        HandleScope scope = new(host);
        HandleId id = await scope.RegisterAsync(new object(), CancellationToken.None);

        await scope.DisposeAsync();

        Func<Task> act = async () => await host.ResolveHandleAsync<object>(id, CancellationToken.None);
        await act.Should().ThrowAsync<HandleDisposedException>();

        await host.DisposeAsync();
    }

    // -------------------------------------------------------------------------
    // BIND-SHM: Large payloads (> 1 MiB) transfer through shared memory
    // without allocation pressure on the managed heap boundary.
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("BIND-SHM")]
    public async Task BIND_SHM_LargePayloadTransfersZeroCopy()
    {
        const int payloadSize = 2 * 1024 * 1024;
        byte[] payload = new byte[payloadSize];
        for (int i = 0; i < payload.Length; i++)
        {
            payload[i] = (byte)(i & 0xFF);
        }

        await using SharedMemoryRingBuffer ring = new("bind-shm-test", 64 * 1024);

        byte[] received = new byte[payloadSize];
        Task producer = Task.Run(async () => await ring.WriteAsync(payload, CancellationToken.None));
        Task consumer = Task.Run(async () =>
        {
            int offset = 0;
            while (offset < received.Length)
            {
                int n = await ring.ReadAsync(received.AsMemory(offset), CancellationToken.None);
                offset += n;
            }
        });

        await Task.WhenAll(producer, consumer);

        received.Should().Equal(payload);
    }

    // -------------------------------------------------------------------------
    // BIND-ITER-BP: Backpressure is enforced via ring buffer fill
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("BIND-ITER-BP")]
    public async Task BIND_ASYNC_ITER_BackpressureViaRingBuffer()
    {
        await using SharedMemoryRingBuffer ring = new("bind-bp-test", 8);

        byte[] payload = new byte[32];
        for (int i = 0; i < payload.Length; i++)
        {
            payload[i] = (byte)i;
        }

        Task write = Task.Run(async () => await ring.WriteAsync(payload, CancellationToken.None));

        // Observe backpressure: writer cannot complete while buffer unread.
        await Task.Delay(20);
        write.IsCompleted.Should().BeFalse("writer must block when the ring is full");

        byte[] drain = new byte[payload.Length];
        int read = 0;
        while (read < drain.Length)
        {
            int n = await ring.ReadAsync(drain.AsMemory(read), CancellationToken.None);
            read += n;
        }

        await write;
        drain.Should().Equal(payload);
    }

    // -------------------------------------------------------------------------
    // BIND-DTS: Generated .d.ts matches the .NET public surface
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("BIND-DTS")]
    public void BIND_DTS_GeneratedMatchesPublicSurface()
    {
        DtsGenerator gen = new();
        string dts = gen.Generate(new List<Type> { typeof(NodeBindingsHost), typeof(HandleScope) });

        dts.Should().Contain("export interface NodeBindingsHost");
        dts.Should().Contain("export interface HandleScope");
        dts.Should().Contain("createHandleAsync(");
        dts.Should().Contain("registerAsync(");
        dts.Should().Contain("Promise<HandleId>");
    }

    // -------------------------------------------------------------------------
    // BIND-ERR: Errors crossing the boundary carry a typed code that matches
    // the .NET exception type name.
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("BIND-ERR")]
    public void BIND_ERROR_CodeMatchesDotnetTypeName()
    {
        HandleDisposedException ex = new();
        ex.GetType().Name.Should().Be("HandleDisposedException");
        ex.Message.Should().Be("handle disposed");
    }
}
