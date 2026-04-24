// <copyright file="AnalyzersAcceptanceTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Threading.Tasks;
using AiOrchestrator.Analyzers;
using AiOrchestrator.Analyzers.Rules.OE0001;
using AiOrchestrator.Analyzers.Rules.OE0002;
using AiOrchestrator.Analyzers.Rules.OE0003;
using AiOrchestrator.Analyzers.Rules.OE0004;
using AiOrchestrator.Analyzers.Rules.OE0005;
using AiOrchestrator.Analyzers.Rules.OE0006;
using AiOrchestrator.Analyzers.Rules.OE0007;
using AiOrchestrator.Analyzers.Rules.OE0008;
using AiOrchestrator.Analyzers.Rules.OE0009;
using AiOrchestrator.Analyzers.Rules.OE0010;
using AiOrchestrator.Analyzers.Rules.OE0011;
using AiOrchestrator.Analyzers.Rules.OE0012;
using AiOrchestrator.Analyzers.Rules.OE0020;
using AiOrchestrator.Analyzers.Rules.OE0030;
using AiOrchestrator.Analyzers.Rules.OE0040;
using AiOrchestrator.Analyzers.Rules.OE0046;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace AiOrchestrator.Analyzers.Tests;

/// <summary>
/// Marks a test method as verifying a specific acceptance criterion or rule ID.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    public ContractTestAttribute(string id) => Id = id;

    /// <summary>Gets the rule or acceptance-criterion ID this test verifies.</summary>
    public string Id { get; }
}

/// <summary>Shared helper for running Roslyn analyzers against in-memory source code.</summary>
internal static class AnalyzerTestHelper
{
    private static readonly ImmutableArray<MetadataReference> References = CreateReferences();

    private static ImmutableArray<MetadataReference> CreateReferences()
    {
        // Force-load key BCL assemblies before snapshotting the AppDomain.
        _ = typeof(System.IO.File).Assembly;
        _ = typeof(System.Diagnostics.Process).Assembly;
        _ = typeof(System.Text.Json.JsonSerializer).Assembly;
        _ = typeof(System.Runtime.InteropServices.DllImportAttribute).Assembly;
        _ = typeof(System.Threading.CancellationToken).Assembly;
        _ = typeof(System.Threading.Tasks.Task).Assembly;

        var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var refs = new System.Collections.Generic.List<MetadataReference>();
        foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!a.IsDynamic && !string.IsNullOrEmpty(a.Location) && seen.Add(a.Location))
            {
                refs.Add(MetadataReference.CreateFromFile(a.Location));
            }
        }

        return ImmutableArray.CreateRange(refs);
    }

    internal static async Task<ImmutableArray<Diagnostic>> GetDiagnosticsAsync(
        string source, DiagnosticAnalyzer analyzer)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { tree },
            References,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        return await withAnalyzers.GetAnalyzerDiagnosticsAsync();
    }

    /// <summary>
    /// Runs an analyzer against a consumer assembly that references a separate service assembly.
    /// Use this when the analyzer distinguishes same-assembly vs cross-assembly instantiation.
    /// </summary>
    internal static async Task<ImmutableArray<Diagnostic>> GetCrossAssemblyDiagnosticsAsync(
        string referencedSource, string referencedAssemblyName,
        string consumerSource, DiagnosticAnalyzer analyzer)
    {
        var refTree = CSharpSyntaxTree.ParseText(referencedSource);
        var refCompilation = CSharpCompilation.Create(
            referencedAssemblyName,
            new[] { refTree },
            References,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var consumerTree = CSharpSyntaxTree.ParseText(consumerSource);
        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { consumerTree },
            References.Add(refCompilation.ToMetadataReference()),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        return await withAnalyzers.GetAnalyzerDiagnosticsAsync();
    }
}

// OE0001 — Public type or member missing XML doc comment

/// <summary>Acceptance tests for OE0001.</summary>
public sealed class OE0001Tests
{
    [Fact]
    [ContractTest("OE0001")]
    public async Task OE0001_PositiveCase_FlagsMissingDoc()
    {
        const string source = @"
public class MyClass
{
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0001Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0001);
    }

    [Fact]
    [ContractTest("OE0001")]
    public async Task OE0001_NegativeCase_QuietWhenDocPresent()
    {
        const string source = @"
/// <summary>My class.</summary>
public class MyClass
{
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0001Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0001);
    }
}

// OE0002 — new ConcreteService() outside Composition

/// <summary>Acceptance tests for OE0002.</summary>
public sealed class OE0002Tests
{
    [Fact]
    [ContractTest("OE0002")]
    public async Task OE0002_PositiveCase_FlagsNewOutsideComposition()
    {
        // Service assembly: defines an AiOrchestrator interface and a class implementing it.
        const string serviceSource = @"
namespace AiOrchestrator.Contracts
{
    public interface IMyService { }
}
namespace AiOrchestrator.SomeService
{
    public class MyService : AiOrchestrator.Contracts.IMyService { }
}";
        // Consumer assembly: instantiates the cross-assembly service outside a composition root.
        const string consumerSource = @"
namespace AiOrchestrator.OtherProject
{
    using AiOrchestrator.SomeService;
    public class Consumer
    {
        public void Use() { var s = new MyService(); }
    }
}";
        var diags = await AnalyzerTestHelper.GetCrossAssemblyDiagnosticsAsync(
            serviceSource, "ServiceAssembly", consumerSource, new OE0002Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0002);
    }

    [Fact]
    [ContractTest("OE0002")]
    public async Task OE0002_NegativeCase_QuietInsideComposition()
    {
        const string source = @"
namespace AiOrchestrator.SomeService
{
    public class MyService { }
}
namespace AiOrchestrator.Composition
{
    using AiOrchestrator.SomeService;
    public class CompositionRoot
    {
        public void Register() { var s = new MyService(); }
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0002Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0002);
    }
}

// OE0003 — Microsoft.VisualStudio reference outside extension transport

/// <summary>Acceptance tests for OE0003.</summary>
public sealed class OE0003Tests
{
    [Fact]
    [ContractTest("OE0003")]
    public async Task OE0003_PositiveCase_FlagsVsNamespaceUsage()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    using Microsoft.VisualStudio.Shell;
    public class Foo { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0003Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0003);
    }

    [Fact]
    [ContractTest("OE0003")]
    public async Task OE0003_NegativeCase_QuietWhenNoVsNamespace()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    using System;
    public class Foo { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0003Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0003);
    }
}

// OE0004 — System.IO.File/Directory outside FileSystem project

/// <summary>Acceptance tests for OE0004.</summary>
public sealed class OE0004Tests
{
    [Fact]
    [ContractTest("OE0004")]
    public async Task OE0004_PositiveCase_FlagsFileIoUsage()
    {
        const string source = @"
using System.IO;
namespace AiOrchestrator.Core
{
    public class Worker
    {
        public void Run() { _ = File.Exists(""x""); }
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0004Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0004);
    }

    [Fact]
    [ContractTest("OE0004")]
    public async Task OE0004_NegativeCase_QuietWhenNoFileSystemUsage()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Worker { public void Run() { } }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0004Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0004);
    }
}

// OE0005 — System.Diagnostics.Process outside Process project

/// <summary>Acceptance tests for OE0005.</summary>
public sealed class OE0005Tests
{
    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_PositiveCase_FlagsProcessUsage()
    {
        const string source = @"
using System.Diagnostics;
namespace AiOrchestrator.Core
{
    public class Worker
    {
        public void Run() { var p = new Process(); }
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0005Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_NegativeCase_QuietWhenNoProcessUsage()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Worker { public void Run() { } }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0005Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0005);
    }
}

// OE0006 — LibGit2Sharp outside Git project

/// <summary>Acceptance tests for OE0006.</summary>
public sealed class OE0006Tests
{
    [Fact]
    [ContractTest("OE0006")]
    public async Task OE0006_PositiveCase_FlagsLibGit2SharpUsage()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    using LibGit2Sharp;
    public class Worker { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0006Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0006);
    }

    [Fact]
    [ContractTest("OE0006")]
    public async Task OE0006_NegativeCase_QuietWhenNoGitUsage()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Worker { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0006Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0006);
    }
}

// OE0007 — Async method missing CancellationToken

/// <summary>Acceptance tests for OE0007.</summary>
public sealed class OE0007Tests
{
    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_PositiveCase_FlagsMissingToken()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public async Task DoWorkAsync() => await Task.CompletedTask;
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_NegativeCase_QuietWhenTokenPresent()
    {
        const string source = @"
using System.Threading;
using System.Threading.Tasks;
public class MyService
{
    public async Task DoWorkAsync(CancellationToken ct) => await Task.CompletedTask;
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }
}

// OE0008 — async void

/// <summary>Acceptance tests for OE0008.</summary>
public sealed class OE0008Tests
{
    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_PositiveCase_FlagsAsyncVoid()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyClass
{
    public async void BadMethod() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_NegativeCase_QuietWhenAsyncTask()
    {
        const string source = @"
using System.Threading;
using System.Threading.Tasks;
public class MyClass
{
    public async Task GoodMethod(CancellationToken ct) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0008);
    }
}

// OE0009 — [DllImport] instead of [LibraryImport]

/// <summary>Acceptance tests for OE0009.</summary>
public sealed class OE0009Tests
{
    [Fact]
    [ContractTest("OE0009")]
    public async Task OE0009_PositiveCase_FlagsDllImport()
    {
        const string source = @"
using System.Runtime.InteropServices;
public partial class NativeMethods
{
    [DllImport(""user32.dll"")]
    public static extern int GetMessage();
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0009Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0009);
    }

    [Fact]
    [ContractTest("OE0009")]
    public async Task OE0009_NegativeCase_QuietWithNoNativeInterop()
    {
        const string source = @"
public class MyClass
{
    public void DoWork() { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0009Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0009);
    }
}

// OE0010 — Banned time/clock APIs

/// <summary>Acceptance tests for OE0010.</summary>
public sealed class OE0010Tests
{
    [Fact]
    [ContractTest("OE0010")]
    public async Task OE0010_PositiveCase_FlagsDateTimeUtcNow()
    {
        const string source = @"
using System;
public class Worker
{
    public void Run() { var t = DateTime.UtcNow; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0010Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0010);
    }

    [Fact]
    [ContractTest("OE0010")]
    public async Task OE0010_NegativeCase_QuietWhenNoBannedApiUsed()
    {
        const string source = @"
public class Worker { public void Run() { } }";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0010Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0010);
    }
}

// OE0011 — Synchronous File I/O

/// <summary>Acceptance tests for OE0011.</summary>
public sealed class OE0011Tests
{
    [Fact]
    [ContractTest("OE0011")]
    public async Task OE0011_PositiveCase_FlagsSyncReadAllText()
    {
        const string source = @"
using System.IO;
public class Worker
{
    public void Run() { var s = File.ReadAllText(""x""); }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0011Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0011);
    }

    [Fact]
    [ContractTest("OE0011")]
    public async Task OE0011_NegativeCase_QuietWhenNoSyncIo()
    {
        const string source = @"
public class Worker { public void Run() { } }";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0011Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0011);
    }
}

// OE0012 — Process.Start is banned

/// <summary>Acceptance tests for OE0012.</summary>
public sealed class OE0012Tests
{
    [Fact]
    [ContractTest("OE0012")]
    public async Task OE0012_PositiveCase_FlagsProcessStart()
    {
        const string source = @"
using System.Diagnostics;
public class Worker
{
    public void Run() { Process.Start(""notepad""); }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0012Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0012);
    }

    [Fact]
    [ContractTest("OE0012")]
    public async Task OE0012_NegativeCase_QuietWhenNoProcessStart()
    {
        const string source = @"
public class Worker { public void Run() { } }";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0012Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0012);
    }
}

// OE0020 — Public method with dynamic or object parameter

/// <summary>Acceptance tests for OE0020.</summary>
public sealed class OE0020Tests
{
    [Fact]
    [ContractTest("OE0020")]
    public async Task OE0020_PositiveCase_FlagsDynamicParameter()
    {
        const string source = @"
public class Worker
{
    public void DoWork(dynamic value) { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0020Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0020);
    }

    [Fact]
    [ContractTest("OE0020")]
    public async Task OE0020_NegativeCase_QuietWithTypedParameters()
    {
        const string source = @"
public class Worker
{
    public void DoWork(string value) { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0020Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0020);
    }
}

// OE0030 — Test method missing [ContractTest]

/// <summary>Acceptance tests for OE0030.</summary>
public sealed class OE0030Tests
{
    [Fact]
    [ContractTest("OE0030")]
    public async Task OE0030_PositiveCase_FlagsMissingContractTest()
    {
        const string source = @"
using Xunit;
public sealed class MyTests
{
    [Fact]
    public void SomeTest() { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0030Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0030);
    }

    [Fact]
    [ContractTest("OE0030")]
    public async Task OE0030_NegativeCase_QuietWhenContractTestPresent()
    {
        const string source = @"
using System;
using Xunit;
[AttributeUsage(AttributeTargets.Method)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) { }
}
public sealed class MyTests
{
    [Fact]
    [ContractTest(""OE0001"")]
    public void SomeTest() { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0030Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0030);
    }
}

// OE0040 — Reflection-based JSON serialization

/// <summary>Acceptance tests for OE0040.</summary>
public sealed class OE0040Tests
{
    [Fact]
    [ContractTest("OE0040")]
    public async Task OE0040_PositiveCase_FlagsReflectionSerialization()
    {
        const string source = @"
using System.Text.Json;
public class Worker
{
    public void Run()
    {
        var obj = new Worker();
        var json = JsonSerializer.Serialize(obj);
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0040Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0040);
    }

    [Fact]
    [ContractTest("OE0040")]
    public async Task OE0040_NegativeCase_QuietWhenNoJsonSerialization()
    {
        const string source = @"
public class Worker { public void Run() { } }";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0040Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0040);
    }
}

// OE0046 — Logger string interpolation

/// <summary>Acceptance tests for OE0046.</summary>
public sealed class OE0046Tests
{
    [Fact]
    [ContractTest("OE0046")]
    public async Task OE0046_PositiveCase_FlagsInterpolation()
    {
        const string source = @"
public interface ILogger { void LogInformation(string msg, params object[] args); }
public class Worker
{
    private readonly ILogger _logger;
    public Worker(ILogger logger) => _logger = logger;
    public void Run(string name)
    {
        _logger.LogInformation($""Hello {name}"");
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0046Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0046);
    }

    [Fact]
    [ContractTest("OE0046")]
    public async Task OE0046_NegativeCase_QuietWithStructuredTemplate()
    {
        const string source = @"
public interface ILogger { void LogInformation(string msg, params object[] args); }
public class Worker
{
    private readonly ILogger _logger;
    public Worker(ILogger logger) => _logger = logger;
    public void Run(string name)
    {
        _logger.LogInformation(""Hello {Name}"", name);
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0046Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0046);
    }
}

// Pack and dogfood structural checks

/// <summary>Structural acceptance tests for the analyzer NuGet pack output and dogfood gate.</summary>
public sealed class AnalyzersPackAndDogfoodTests
{
    private static readonly string RepoRoot = FindRepoRoot();

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "dotnet", "src")))
            {
                return dir.FullName;
            }

            dir = dir.Parent!;
        }

        throw new InvalidOperationException("Cannot locate repo root from " + AppContext.BaseDirectory);
    }

    [Fact]
    [ContractTest("ANALYZERS-PACK")]
    public void ANALYZERS_PACK_IsPackedAsAnalyzerOutput()
    {
        var csproj = Path.Combine(
            RepoRoot, "dotnet", "src", "tooling", "AiOrchestrator.Analyzers",
            "AiOrchestrator.Analyzers.csproj");

        Assert.True(File.Exists(csproj), "Analyzer csproj must exist");
        var content = File.ReadAllText(csproj);
        Assert.Contains("IsPackable>true", content);
        Assert.Contains("IsAnalyzer>true", content);
        Assert.Contains("analyzers/dotnet/cs", content);
    }

    [Fact]
    [ContractTest("ANALYZERS-DOGFOOD")]
    public void ANALYZERS_DOGFOOD_AppliesToOwnSource()
    {
        var targets = Path.Combine(
            RepoRoot, "dotnet", "Directory.Build.targets");

        Assert.True(File.Exists(targets), "Directory.Build.targets must exist");
        var content = File.ReadAllText(targets);
        Assert.Contains("AiOrchestrator.Analyzers.csproj", content);
        Assert.Contains("OutputItemType=\"Analyzer\"", content);
    }
}