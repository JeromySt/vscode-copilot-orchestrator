// <copyright file="BindingsNodeCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Bindings.Node.Generators;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AiOrchestrator.Bindings.Node.Tests;

public sealed class BindingsNodeCoverageTests
{
    private static NodeBindingsHost NewHost()
    {
        IServiceProvider sp = new ServiceCollection().BuildServiceProvider();
        return new NodeBindingsHost(sp);
    }

    // ─────────── NodeBindingsHost ───────────

    [Fact]
    public void NodeBindingsHost_NullServiceProvider_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new NodeBindingsHost(null!));
    }

    [Fact]
    public async Task NodeBindingsHost_CreateHandleAsync_AfterDispose_Throws()
    {
        var host = NewHost();
        await host.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await host.CreateHandleAsync(new object(), CancellationToken.None));
    }

    [Fact]
    public async Task NodeBindingsHost_ResolveHandleAsync_AfterDispose_Throws()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync(new object(), CancellationToken.None);
        await host.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await host.ResolveHandleAsync<object>(handle, CancellationToken.None));
    }

    [Fact]
    public async Task NodeBindingsHost_DisposeAsync_Idempotent()
    {
        var host = NewHost();
        await host.DisposeAsync();
        await host.DisposeAsync(); // second call — no throw
    }

    [Fact]
    public async Task NodeBindingsHost_DisposeHandleAsync_RemovesHandle()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync("test-value", CancellationToken.None);

        await host.DisposeHandleAsync(handle, CancellationToken.None);

        await Assert.ThrowsAsync<HandleDisposedException>(async () =>
            await host.ResolveHandleAsync<string>(handle, CancellationToken.None));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_DisposeHandleAsync_NonExistent_NoThrow()
    {
        var host = NewHost();
        await host.DisposeHandleAsync(new HandleId(9999), CancellationToken.None); // no throw
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_CreateHandleAsync_NullInstance_Throws()
    {
        var host = NewHost();
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await host.CreateHandleAsync<object>(null!, CancellationToken.None));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_CreateHandleAsync_CancelledToken_Throws()
    {
        var host = NewHost();
        var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await host.CreateHandleAsync(new object(), cts.Token));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_ResolveHandleAsync_CancelledToken_Throws()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync(new object(), CancellationToken.None);
        var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await host.ResolveHandleAsync<object>(handle, cts.Token));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_DisposeHandleAsync_CancelledToken_Throws()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync(new object(), CancellationToken.None);
        var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await host.DisposeHandleAsync(handle, cts.Token));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_TryResolve_Hit()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync("hello", CancellationToken.None);
        var found = host.TryResolve(handle, out var value);
        Assert.True(found);
        Assert.Equal("hello", value);
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_TryResolve_Miss()
    {
        var host = NewHost();
        var found = host.TryResolve(new HandleId(42), out var value);
        Assert.False(found);
        Assert.Null(value);
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_RemoveHandle_RemovesEntry()
    {
        var host = NewHost();
        var handle = await host.CreateHandleAsync("data", CancellationToken.None);
        host.RemoveHandle(handle);
        var found = host.TryResolve(handle, out _);
        Assert.False(found);
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_RemoveHandle_NonExistent_NoThrow()
    {
        var host = NewHost();
        host.RemoveHandle(new HandleId(77)); // should not throw
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_RegisterInternal_AssignsIncrementingIds()
    {
        var host = NewHost();
        var h1 = host.RegisterInternal("a");
        var h2 = host.RegisterInternal("b");
        Assert.True(h2.Value > h1.Value);
        await host.DisposeAsync();
    }

    [Fact]
    public async Task NodeBindingsHost_Services_ExposesDiContainer()
    {
        var host = NewHost();
        Assert.NotNull(host.Services);
        await host.DisposeAsync();
    }

    // ─────────── HandleScope ───────────

    [Fact]
    public void HandleScope_NullHost_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new HandleScope(null!));
    }

    [Fact]
    public async Task HandleScope_RegisterAsync_AfterDispose_Throws()
    {
        var host = NewHost();
        var scope = new HandleScope(host);
        await scope.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await scope.RegisterAsync(new object(), CancellationToken.None));
        await host.DisposeAsync();
    }

    [Fact]
    public async Task HandleScope_RegisterAsync_NullInstance_Throws()
    {
        var host = NewHost();
        var scope = new HandleScope(host);
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await scope.RegisterAsync<object>(null!, CancellationToken.None));
        await scope.DisposeAsync();
        await host.DisposeAsync();
    }

    [Fact]
    public async Task HandleScope_RegisterAsync_CancelledToken_Throws()
    {
        var host = NewHost();
        var scope = new HandleScope(host);
        var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await scope.RegisterAsync(new object(), cts.Token));
        await scope.DisposeAsync();
        await host.DisposeAsync();
    }

    [Fact]
    public async Task HandleScope_DisposeAsync_Idempotent()
    {
        var host = NewHost();
        var scope = new HandleScope(host);
        await scope.DisposeAsync();
        await scope.DisposeAsync(); // second dispose — no throw
        await host.DisposeAsync();
    }

    // ─────────── HandleDisposedException ───────────

    [Fact]
    public void HandleDisposedException_DefaultConstructor()
    {
        var ex = new HandleDisposedException();
        Assert.Equal("handle disposed", ex.Message);
    }

    [Fact]
    public void HandleDisposedException_MessageConstructor()
    {
        var ex = new HandleDisposedException("custom message");
        Assert.Equal("custom message", ex.Message);
    }

    [Fact]
    public void HandleDisposedException_MessageAndInnerConstructor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new HandleDisposedException("outer", inner);
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    // ─────────── DtsGenerator ───────────

    [Fact]
    public void DtsGenerator_Generate_NullTypes_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => DtsGenerator.Generate(null!));
    }

    [Fact]
    public void DtsGenerator_Generate_EmptyTypes_ReturnsHeader()
    {
        var result = DtsGenerator.Generate(new List<Type>());
        Assert.Contains("auto-generated", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsStringProperty()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(StringHolder) });
        Assert.Contains("name: string;", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsBooleanProperty()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(BoolHolder) });
        Assert.Contains("active: boolean;", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsNumberTypes()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(NumberHolder) });
        Assert.Contains("count: number;", result);
        Assert.Contains("big: number;", result);
        Assert.Contains("ratio: number;", result);
        Assert.Contains("precise: number;", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsByteArrayToUint8Array()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(ByteHolder) });
        Assert.Contains("data: Uint8Array;", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsTaskToPromiseVoid()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(TaskHolder) });
        Assert.Contains("Promise<void>;", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MapsGenericTaskToPromise()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(GenericTaskHolder) });
        Assert.Contains("Promise<string>", result);
    }

    [Fact]
    public void DtsGenerator_Generate_ExcludesObjectMethods()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(StringHolder) });
        Assert.DoesNotContain("toString", result);
        Assert.DoesNotContain("equals", result);
        Assert.DoesNotContain("getHashCode", result);
    }

    [Fact]
    public void DtsGenerator_Generate_ExcludesPropertyAccessors()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(StringHolder) });
        Assert.DoesNotContain("get_", result);
        Assert.DoesNotContain("set_", result);
    }

    [Fact]
    public void DtsGenerator_Generate_UsesInterfaceKeyword()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(StringHolder) });
        Assert.Contains("export interface StringHolder {", result);
    }

    [Fact]
    public void DtsGenerator_Generate_MultipleTypes_SortedByName()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(ZType), typeof(AType) });
        var aIdx = result.IndexOf("AType", StringComparison.Ordinal);
        var zIdx = result.IndexOf("ZType", StringComparison.Ordinal);
        Assert.True(aIdx < zIdx, "types should be sorted alphabetically");
    }

    [Fact]
    public void DtsGenerator_Generate_CamelCasesPropertyNames()
    {
        var result = DtsGenerator.Generate(new List<Type> { typeof(CamelCaseHolder) });
        Assert.Contains("myProperty: string;", result);
    }

    // ─────────── HandleId ───────────

    [Fact]
    public void HandleId_ValueEquality()
    {
        var a = new HandleId(42);
        var b = new HandleId(42);
        Assert.Equal(a, b);
    }

    [Fact]
    public void HandleId_DifferentValues_NotEqual()
    {
        Assert.NotEqual(new HandleId(1), new HandleId(2));
    }

    // ─────────── Test DTOs for DtsGenerator ───────────

    public class StringHolder
    {
        public string Name { get; set; } = string.Empty;
    }

    public class BoolHolder
    {
        public bool Active { get; set; }
    }

    public class NumberHolder
    {
        public int Count { get; set; }

        public long Big { get; set; }

        public double Ratio { get; set; }

        public float Precise { get; set; }
    }

    public class ByteHolder
    {
        public byte[] Data { get; set; } = Array.Empty<byte>();
    }

    public class TaskHolder
    {
        public Task DoWorkAsync() => Task.CompletedTask;
    }

    public class GenericTaskHolder
    {
        public Task<string> GetNameAsync() => Task.FromResult("name");
    }

    public class CamelCaseHolder
    {
        public string MyProperty { get; set; } = string.Empty;
    }

    public class AType
    {
        public int Val { get; set; }
    }

    public class ZType
    {
        public int Val { get; set; }
    }
}
