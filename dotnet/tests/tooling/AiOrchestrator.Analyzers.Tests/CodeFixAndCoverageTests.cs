// <copyright file="CodeFixAndCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Analyzers;
using AiOrchestrator.Analyzers.Rules.OE0001;
using AiOrchestrator.Analyzers.Rules.OE0005;
using AiOrchestrator.Analyzers.Rules.OE0007;
using AiOrchestrator.Analyzers.Rules.OE0008;
using AiOrchestrator.Analyzers.Rules.OE0009;
using AiOrchestrator.Analyzers.Rules.OE0030;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace AiOrchestrator.Analyzers.Tests;

/// <summary>Shared helper for applying code fixes to source code and returning the transformed text.</summary>
internal static class CodeFixRunner
{
    internal static async Task<string> ApplyAsync(
        string source, DiagnosticAnalyzer analyzer, CodeFixProvider codeFix, string diagnosticId)
    {
        var references = GetReferences();
        var tree = CSharpSyntaxTree.ParseText(source);

        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        var diagnostics = await withAnalyzers.GetAnalyzerDiagnosticsAsync();
        var diagnostic = diagnostics.FirstOrDefault(d => d.Id == diagnosticId);
        if (diagnostic is null)
        {
            return source;
        }

        using var workspace = new Microsoft.CodeAnalysis.AdhocWorkspace();
        var project = workspace.AddProject("TestProject", LanguageNames.CSharp);
        project = project
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .WithMetadataReferences(references);
        var document = project.AddDocument("TestFile.cs", SourceText.From(source));

        var docCompilation = await document.Project.GetCompilationAsync();
        if (docCompilation is null)
        {
            return source;
        }

        var docWithAnalyzers = docCompilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        var docDiagnostics = await docWithAnalyzers.GetAnalyzerDiagnosticsAsync();
        var docDiag = docDiagnostics.FirstOrDefault(d => d.Id == diagnosticId);
        if (docDiag is null)
        {
            return source;
        }

        var actions = new System.Collections.Generic.List<CodeAction>();
        var context = new CodeFixContext(document, docDiag,
            (a, _) => actions.Add(a), CancellationToken.None);
        await codeFix.RegisterCodeFixesAsync(context);

        if (actions.Count == 0)
        {
            return source;
        }

        var operations = await actions[0].GetOperationsAsync(CancellationToken.None);
        var applyOp = operations.OfType<ApplyChangesOperation>().FirstOrDefault();
        if (applyOp is null)
        {
            return source;
        }

        applyOp.Apply(workspace, CancellationToken.None);
        var changedDoc = workspace.CurrentSolution.GetDocument(document.Id);
        if (changedDoc is null)
        {
            return source;
        }

        var changedText = await changedDoc.GetTextAsync();
        return changedText.ToString();
    }

    private static ImmutableArray<MetadataReference> GetReferences()
    {
        _ = typeof(System.IO.File).Assembly;
        _ = typeof(System.Diagnostics.Process).Assembly;
        _ = typeof(System.Text.Json.JsonSerializer).Assembly;
        _ = typeof(System.Runtime.InteropServices.DllImportAttribute).Assembly;
        _ = typeof(System.Threading.CancellationToken).Assembly;
        _ = typeof(System.Threading.Tasks.Task).Assembly;
        _ = typeof(Xunit.FactAttribute).Assembly;

        var seen = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
        var refs = new System.Collections.Generic.List<MetadataReference>();
        foreach (var a in System.AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!a.IsDynamic && !string.IsNullOrEmpty(a.Location) && seen.Add(a.Location))
            {
                refs.Add(MetadataReference.CreateFromFile(a.Location));
            }
        }

        return ImmutableArray.CreateRange(refs);
    }
}

/// <summary>Shared helper for running analyzers with a custom file path or assembly name.</summary>
internal static class CustomAnalyzerTestHelper
{
    internal static async Task<ImmutableArray<Diagnostic>> GetDiagnosticsWithFilePathAsync(
        string source, DiagnosticAnalyzer analyzer, string filePath)
    {
        var tree = CSharpSyntaxTree.ParseText(source, path: filePath);
        var refs = GetReferences();
        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { tree },
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        return await withAnalyzers.GetAnalyzerDiagnosticsAsync();
    }

    internal static async Task<ImmutableArray<Diagnostic>> GetDiagnosticsWithAssemblyNameAsync(
        string source, DiagnosticAnalyzer analyzer, string assemblyName)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var refs = GetReferences();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        return await withAnalyzers.GetAnalyzerDiagnosticsAsync();
    }

    private static ImmutableArray<MetadataReference> GetReferences()
    {
        var seen = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
        var refs = new System.Collections.Generic.List<MetadataReference>();
        foreach (var a in System.AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!a.IsDynamic && !string.IsNullOrEmpty(a.Location) && seen.Add(a.Location))
            {
                refs.Add(MetadataReference.CreateFromFile(a.Location));
            }
        }

        return ImmutableArray.CreateRange(refs);
    }
}

// ============================================================================
// OE0001 CodeFix Tests
// ============================================================================

/// <summary>Tests for OE0001CodeFix — adds XML documentation comment template.</summary>
public sealed class OE0001CodeFixTests
{
    [Fact]
    [ContractTest("OE0001-FIX")]
    public async Task CodeFix_AddsXmlDocToClass()
    {
        const string source = @"
public class MyClass
{
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0001Analyzer(), new OE0001CodeFix(), DiagnosticIds.OE0001);
        Assert.Contains("/// <summary>", result);
        Assert.Contains("/// TODO: Add documentation.", result);
        Assert.Contains("/// </summary>", result);
    }

    [Fact]
    [ContractTest("OE0001-FIX")]
    public async Task CodeFix_AddsXmlDocToMethod()
    {
        const string source = @"
/// <summary>A class.</summary>
public class MyClass
{
    public void MyMethod() { }
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0001Analyzer(), new OE0001CodeFix(), DiagnosticIds.OE0001);
        Assert.Contains("/// <summary>", result);
        Assert.Contains("/// TODO: Add documentation.", result);
    }

    [Fact]
    [ContractTest("OE0001-FIX")]
    public async Task CodeFix_AddsXmlDocToProperty()
    {
        const string source = @"
/// <summary>A class.</summary>
public class MyClass
{
    public int Value { get; set; }
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0001Analyzer(), new OE0001CodeFix(), DiagnosticIds.OE0001);
        Assert.Contains("/// <summary>", result);
    }

    [Fact]
    [ContractTest("OE0001-FIX")]
    public void CodeFix_FixableDiagnosticIds_ReturnsOE0001()
    {
        var fix = new OE0001CodeFix();
        Assert.Contains(DiagnosticIds.OE0001, fix.FixableDiagnosticIds);
    }

    [Fact]
    [ContractTest("OE0001-FIX")]
    public void CodeFix_GetFixAllProvider_ReturnsBatchFixer()
    {
        var fix = new OE0001CodeFix();
        Assert.NotNull(fix.GetFixAllProvider());
    }
}

// ============================================================================
// OE0007 CodeFix Tests
// ============================================================================

/// <summary>Tests for OE0007CodeFix — adds CancellationToken parameter.</summary>
public sealed class OE0007CodeFixTests
{
    [Fact]
    [ContractTest("OE0007-FIX")]
    public async Task CodeFix_AddsCancellationTokenToEmptyParamList()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public async Task DoWorkAsync() => await Task.CompletedTask;
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0007Analyzer(), new OE0007CodeFix(), DiagnosticIds.OE0007);
        Assert.Contains("CancellationToken", result);
        Assert.Contains("cancellationToken", result);
    }

    [Fact]
    [ContractTest("OE0007-FIX")]
    public async Task CodeFix_AddsCancellationTokenToExistingParams()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public async Task DoWorkAsync(string input) => await Task.CompletedTask;
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0007Analyzer(), new OE0007CodeFix(), DiagnosticIds.OE0007);
        Assert.Contains("CancellationToken", result);
        Assert.Contains("string input", result);
    }

    [Fact]
    [ContractTest("OE0007-FIX")]
    public void CodeFix_FixableDiagnosticIds_ReturnsOE0007()
    {
        var fix = new OE0007CodeFix();
        Assert.Contains(DiagnosticIds.OE0007, fix.FixableDiagnosticIds);
    }

    [Fact]
    [ContractTest("OE0007-FIX")]
    public void CodeFix_GetFixAllProvider_ReturnsBatchFixer()
    {
        var fix = new OE0007CodeFix();
        Assert.NotNull(fix.GetFixAllProvider());
    }
}

// ============================================================================
// OE0008 CodeFix Tests
// ============================================================================

/// <summary>Tests for OE0008CodeFix — changes async void to async Task.</summary>
public sealed class OE0008CodeFixTests
{
    [Fact]
    [ContractTest("OE0008-FIX")]
    public async Task CodeFix_ChangesAsyncVoidToAsyncTask()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyClass
{
    public async void BadMethod() { await Task.CompletedTask; }
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0008Analyzer(), new OE0008CodeFix(), DiagnosticIds.OE0008);
        Assert.Contains("Task", result);
        Assert.DoesNotContain("async void BadMethod", result);
    }

    [Fact]
    [ContractTest("OE0008-FIX")]
    public void CodeFix_FixableDiagnosticIds_ReturnsOE0008()
    {
        var fix = new OE0008CodeFix();
        Assert.Contains(DiagnosticIds.OE0008, fix.FixableDiagnosticIds);
    }

    [Fact]
    [ContractTest("OE0008-FIX")]
    public void CodeFix_GetFixAllProvider_ReturnsBatchFixer()
    {
        var fix = new OE0008CodeFix();
        Assert.NotNull(fix.GetFixAllProvider());
    }
}

// ============================================================================
// OE0009 CodeFix Tests
// ============================================================================

/// <summary>Tests for OE0009CodeFix — replaces [DllImport] with [LibraryImport].</summary>
public sealed class OE0009CodeFixTests
{
    [Fact]
    [ContractTest("OE0009-FIX")]
    public async Task CodeFix_ReplacesDllImportWithLibraryImport()
    {
        const string source = @"
using System.Runtime.InteropServices;
public partial class NativeMethods
{
    [DllImport(""user32.dll"")]
    public static extern int GetMessage();
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0009Analyzer(), new OE0009CodeFix(), DiagnosticIds.OE0009);
        Assert.Contains("LibraryImport", result);
    }

    [Fact]
    [ContractTest("OE0009-FIX")]
    public void CodeFix_FixableDiagnosticIds_ReturnsOE0009()
    {
        var fix = new OE0009CodeFix();
        Assert.Contains(DiagnosticIds.OE0009, fix.FixableDiagnosticIds);
    }

    [Fact]
    [ContractTest("OE0009-FIX")]
    public void CodeFix_GetFixAllProvider_ReturnsBatchFixer()
    {
        var fix = new OE0009CodeFix();
        Assert.NotNull(fix.GetFixAllProvider());
    }
}

// ============================================================================
// OE0030 CodeFix Tests
// ============================================================================

/// <summary>Tests for OE0030CodeFix — adds [ContractTest("TODO")] attribute.</summary>
public sealed class OE0030CodeFixTests
{
    [Fact]
    [ContractTest("OE0030-FIX")]
    public async Task CodeFix_AddsContractTestAttribute()
    {
        const string source = @"
using Xunit;
public sealed class MyTests
{
    [Fact]
    public void SomeTest() { }
}";
        var result = await CodeFixRunner.ApplyAsync(source, new OE0030Analyzer(), new OE0030CodeFix(), DiagnosticIds.OE0030);
        Assert.Contains("ContractTest", result);
        Assert.Contains("TODO", result);
    }

    [Fact]
    [ContractTest("OE0030-FIX")]
    public void CodeFix_FixableDiagnosticIds_ReturnsOE0030()
    {
        var fix = new OE0030CodeFix();
        Assert.Contains(DiagnosticIds.OE0030, fix.FixableDiagnosticIds);
    }

    [Fact]
    [ContractTest("OE0030-FIX")]
    public void CodeFix_GetFixAllProvider_ReturnsBatchFixer()
    {
        var fix = new OE0030CodeFix();
        Assert.NotNull(fix.GetFixAllProvider());
    }
}

// ============================================================================
// OE0043 Analyzer Tests
// ============================================================================

/// <summary>Tests for OE0043 — KeyCeremonyToolingStub may only be referenced from tools/key-ceremony or tests.</summary>
public sealed class OE0043Tests
{
    [Fact]
    [ContractTest("OE0043")]
    public async Task OE0043_Flags_ReferenceFromDaemonPath()
    {
        const string serviceSource = @"
namespace AiOrchestrator.SkewManifest.Tools
{
    public class KeyCeremonyToolingStub { }
}";
        const string consumerSource = @"
namespace AiOrchestrator.Daemon
{
    using AiOrchestrator.SkewManifest.Tools;
    public class DaemonClass
    {
        public void Use() { var s = new KeyCeremonyToolingStub(); }
    }
}";
        var diags = await AnalyzerTestHelper.GetCrossAssemblyDiagnosticsAsync(
            serviceSource, "ServiceAssembly", consumerSource,
            new OE0043_OnlyToolsCanCallKeyCeremony());
        Assert.Contains(diags, d => d.Id == "OE0043");
    }

    [Fact]
    [ContractTest("OE0043")]
    public async Task OE0043_Quiet_ReferenceFromToolsKeyCeremonyPath()
    {
        const string source = @"
namespace AiOrchestrator.SkewManifest.Tools
{
    public class KeyCeremonyToolingStub { }
}
namespace AiOrchestrator.Tools.KeyCeremony
{
    using AiOrchestrator.SkewManifest.Tools;
    public class Tool
    {
        public void Use() { var s = new KeyCeremonyToolingStub(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0043_OnlyToolsCanCallKeyCeremony(),
            "C:/repo/tools/key-ceremony/Tool.cs");
        Assert.DoesNotContain(diags, d => d.Id == "OE0043");
    }

    [Fact]
    [ContractTest("OE0043")]
    public async Task OE0043_Quiet_ReferenceFromTestsPath()
    {
        const string source = @"
namespace AiOrchestrator.SkewManifest.Tools
{
    public class KeyCeremonyToolingStub { }
}
namespace AiOrchestrator.Tests
{
    using AiOrchestrator.SkewManifest.Tools;
    public class TestClass
    {
        public void Test() { var s = new KeyCeremonyToolingStub(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0043_OnlyToolsCanCallKeyCeremony(),
            "C:/repo/tests/TestClass.cs");
        Assert.DoesNotContain(diags, d => d.Id == "OE0043");
    }

    [Fact]
    [ContractTest("OE0043")]
    public async Task OE0043_Quiet_WhenIdentifierIsNotKeyCeremonyToolingStub()
    {
        const string source = @"
public class SomeOtherClass { }
public class Consumer
{
    public void Use() { var s = new SomeOtherClass(); }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(
            source, new OE0043_OnlyToolsCanCallKeyCeremony());
        Assert.DoesNotContain(diags, d => d.Id == "OE0043");
    }

    [Fact]
    [ContractTest("OE0043")]
    public async Task OE0043_Quiet_WhenKeyCeremonyToolingStubInDifferentNamespace()
    {
        const string source = @"
namespace SomeOther.Namespace
{
    public class KeyCeremonyToolingStub { }
}
namespace Consumer
{
    using SomeOther.Namespace;
    public class MyClass
    {
        public void Use() { var s = new KeyCeremonyToolingStub(); }
    }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(
            source, new OE0043_OnlyToolsCanCallKeyCeremony());
        Assert.DoesNotContain(diags, d => d.Id == "OE0043");
    }
}

// ============================================================================
// OE0044 Analyzer Tests
// ============================================================================

/// <summary>Tests for OE0044 — only VsCode.Transport can reference Microsoft.VisualStudio packages.</summary>
public sealed class OE0044Tests
{
    [Fact]
    [ContractTest("OE0044")]
    public async Task OE0044_Flags_VsNamespaceFromNonTransportAssembly()
    {
        const string source = @"
namespace Microsoft.VisualStudio.Shell
{
    public class Package { }
}
namespace AiOrchestrator.Core
{
    public class MyClass
    {
        public void Use() { var p = new Microsoft.VisualStudio.Shell.Package(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithAssemblyNameAsync(
            source, new OE0044_OnlyVsCodeTransportCanReferenceVsPackages(),
            "AiOrchestrator.Core");
        Assert.Contains(diags, d => d.Id == "OE0044");
    }

    [Fact]
    [ContractTest("OE0044")]
    public async Task OE0044_Quiet_VsNamespaceFromTransportAssembly()
    {
        const string source = @"
namespace Microsoft.VisualStudio.Shell
{
    public class Package { }
}
namespace AiOrchestrator.VsCode.Transport
{
    public class MyTransport
    {
        public void Use() { var p = new Microsoft.VisualStudio.Shell.Package(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithAssemblyNameAsync(
            source, new OE0044_OnlyVsCodeTransportCanReferenceVsPackages(),
            "AiOrchestrator.VsCode.Transport");
        Assert.DoesNotContain(diags, d => d.Id == "OE0044");
    }

    [Fact]
    [ContractTest("OE0044")]
    public async Task OE0044_Quiet_WhenNoVsNamespace()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class MyClass
    {
        public void DoWork() { }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithAssemblyNameAsync(
            source, new OE0044_OnlyVsCodeTransportCanReferenceVsPackages(),
            "AiOrchestrator.Core");
        Assert.DoesNotContain(diags, d => d.Id == "OE0044");
    }

    [Fact]
    [ContractTest("OE0044")]
    public async Task OE0044_Flags_UsingDirectiveForVsNamespace()
    {
        const string source = @"
namespace Microsoft.VisualStudio.Shell
{
    public class Package { }
}
namespace AiOrchestrator.Plan
{
    using Microsoft.VisualStudio.Shell;
    public class Worker
    {
        public void Use() { var p = new Package(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithAssemblyNameAsync(
            source, new OE0044_OnlyVsCodeTransportCanReferenceVsPackages(),
            "AiOrchestrator.Plan");
        Assert.Contains(diags, d => d.Id == "OE0044");
    }
}

// ============================================================================
// OE0005 Analyzer Additional Coverage Tests
// ============================================================================

/// <summary>Additional coverage tests for OE0005 — Process usage outside Process project.</summary>
public sealed class OE0005AdditionalTests
{
    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Quiet_WhenInsideProcessProject()
    {
        const string source = @"
using System.Diagnostics;
namespace AiOrchestrator.Process
{
    public class Worker
    {
        public void Run() { var p = new Process(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Process/Worker.cs");
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Flags_ObjectCreationOutsideProcessProject()
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
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Core/Worker.cs");
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Flags_StaticMemberAccess()
    {
        const string source = @"
using System.Diagnostics;
namespace AiOrchestrator.Core
{
    public class Worker
    {
        public void Run() { var p = Process.GetCurrentProcess(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Core/Worker.cs");
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Quiet_WhenUsingNonProcessType()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Worker
    {
        public void Run() { var x = System.Environment.CurrentDirectory; }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Core/Worker.cs");
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Quiet_WhenNestedMemberAccess()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Foo
    {
        public Bar Bar { get; } = new Bar();
    }
    public class Bar
    {
        public string Name { get; set; } = """";
    }
    public class Worker
    {
        public void Run()
        {
            var foo = new Foo();
            var name = foo.Bar.Name;
        }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Core/Worker.cs");
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0005);
    }

    [Fact]
    [ContractTest("OE0005")]
    public async Task OE0005_Quiet_MemberAccessWithNullSymbol()
    {
        const string source = @"
namespace AiOrchestrator.Core
{
    public class Worker
    {
        public void Run() { var x = UnknownThing.DoSomething(); }
    }
}";
        var diags = await CustomAnalyzerTestHelper.GetDiagnosticsWithFilePathAsync(
            source, new OE0005Analyzer(),
            "C:/repo/src/AiOrchestrator.Core/Worker.cs");
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0005);
    }
}

// ============================================================================
// OE0007 Analyzer Additional Coverage Tests
// ============================================================================

/// <summary>Additional coverage tests for OE0007 — async method missing CancellationToken.</summary>
public sealed class OE0007AdditionalTests
{
    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_NonAsyncMethod()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public Task DoWorkAsync() => Task.CompletedTask;
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_AsyncVoidMethod()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public async void OnEvent() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_MainEntryPoint()
    {
        const string source = @"
using System.Threading.Tasks;
public class Program
{
    public static async Task Main() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_PrivateAsyncMethod()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    private async Task DoInternalAsync() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_InterfaceImplementationWithoutToken()
    {
        const string source = @"
using System.Threading.Tasks;
public interface IService
{
    Task DoWorkAsync();
}
public class MyService : IService
{
    public async Task DoWorkAsync() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_InterfaceImplementationWithToken()
    {
        const string source = @"
using System.Threading;
using System.Threading.Tasks;
public interface IService
{
    Task DoWorkAsync(CancellationToken ct);
}
public class MyService : IService
{
    public async Task DoWorkAsync(CancellationToken ct) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Flags_ProtectedAsyncMethod()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    protected async Task DoWorkAsync() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Quiet_InternalAsyncMethod()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    internal async Task DoWorkAsync() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0007);
    }

    [Fact]
    [ContractTest("OE0007")]
    public async Task OE0007_Flags_PublicAsyncWithMultipleNonTokenParams()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyService
{
    public async Task DoWorkAsync(string a, int b) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0007Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0007);
    }
}

// ============================================================================
// OE0008 Analyzer Additional Coverage Tests
// ============================================================================

/// <summary>Additional coverage tests for OE0008 — async void method.</summary>
public sealed class OE0008AdditionalTests
{
    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Quiet_NonAsyncMethod()
    {
        const string source = @"
public class MyClass
{
    public void SyncMethod() { }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Quiet_AsyncTaskMethod()
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

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Quiet_AsyncEventHandlerAttribute()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
[AttributeUsage(AttributeTargets.Method)]
public class AsyncEventHandlerAttribute : Attribute { }
public class MyClass
{
    [AsyncEventHandler]
    public async void OnEvent() { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Quiet_ClassicEventHandlerSignature()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
public class MyClass
{
    public async void OnClicked(object sender, EventArgs e) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Flags_AsyncVoidWithNonEventHandlerParams()
    {
        const string source = @"
using System.Threading.Tasks;
public class MyClass
{
    public async void BadMethod(string input) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Flags_AsyncVoidWithOnlyOneParam()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
public class MyClass
{
    public async void Handler(EventArgs e) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Quiet_DerivedEventArgs()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
public class CustomEventArgs : EventArgs { }
public class MyClass
{
    public async void OnCustomEvent(object sender, CustomEventArgs e) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.DoesNotContain(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Flags_AsyncVoidWithWrongFirstParamType()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
public class MyClass
{
    public async void Handler(string sender, EventArgs e) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0008);
    }

    [Fact]
    [ContractTest("OE0008")]
    public async Task OE0008_Flags_AsyncVoidWithNonEventArgsSecondParam()
    {
        const string source = @"
using System;
using System.Threading.Tasks;
public class MyClass
{
    public async void Handler(object sender, string notEventArgs) { await Task.CompletedTask; }
}";
        var diags = await AnalyzerTestHelper.GetDiagnosticsAsync(source, new OE0008Analyzer());
        Assert.Contains(diags, d => d.Id == DiagnosticIds.OE0008);
    }
}
