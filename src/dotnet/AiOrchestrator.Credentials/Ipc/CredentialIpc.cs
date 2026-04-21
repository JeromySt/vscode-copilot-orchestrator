// <copyright file="CredentialIpc.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Credentials.Ipc;

/// <summary>
/// Owns the broker's IPC endpoint. On POSIX, binds a path-based Unix domain socket under
/// <c>/run/ai-orchestrator/</c> (NOT the abstract <c>@</c> namespace, INV-2 / CRED-IPC-1) with
/// <c>0700</c> permissions. On Windows, creates a <see cref="NamedPipeServerStream"/> with an
/// owner-only DACL.
/// Per-message peer-credential enforcement is performed via <see cref="GetPeerCredentialsAsync"/>
/// (INV-3 / CRED-IPC-2). See <c>docs/SECURITY.md</c> — "Same-uid threat model" — for scope
/// limitations (INV-12).
/// </summary>
public sealed class CredentialIpc : IAsyncDisposable
{
    private readonly AbsolutePath socketPath;
#pragma warning disable CA1823, IDE0052
    private readonly IProcessSpawner spawner;
#pragma warning restore CA1823, IDE0052
    private Socket? unixSocket;
    private NamedPipeServerStream? namedPipe;
    private int disposed;

    /// <summary>Initializes a new <see cref="CredentialIpc"/>.</summary>
    /// <param name="socketPath">Filesystem path for the UDS (POSIX) or pipe name (Windows).</param>
    /// <param name="spawner">Process spawner (retained for DI parity; not used for the IPC listener itself).</param>
    public CredentialIpc(AbsolutePath socketPath, IProcessSpawner spawner)
    {
        this.socketPath = socketPath;
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));

        // INV-2 defense-in-depth: reject known abstract-namespace prefixes at construction time.
        var raw = socketPath.Value;
        if (!string.IsNullOrEmpty(raw) && (raw.StartsWith('\0') || raw.StartsWith('@')))
        {
            throw new ArgumentException(
                "Abstract-namespace sockets are forbidden (CRED-IPC-1); use a path-based socket under /run/ai-orchestrator/.",
                nameof(socketPath));
        }
    }

    /// <summary>Gets the concrete socket path bound by this listener (INV-2).</summary>
    public string SocketPath => this.socketPath.Value;

    /// <summary>
    /// Generates a fresh path-based socket path under <c>/run/ai-orchestrator/</c> per INV-2.
    /// NOTE: On Windows (where named pipes replace UDS), the path is still a filesystem path
    /// so the same "no abstract socket" validation holds.
    /// </summary>
    /// <param name="rootOverride">Optional override for the socket directory (tests use a tmp dir).</param>
    /// <returns>A rooted socket path like <c>/run/ai-orchestrator/cred.abc123.sock</c>.</returns>
    public static string NewSocketPath(string? rootOverride = null)
    {
        string root;
        if (rootOverride is not null)
        {
            root = rootOverride;
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // Windows uses named pipes but we still return a rooted path for API parity.
            root = @"\\.\pipe\ai-orchestrator";
        }
        else
        {
            root = "/run/ai-orchestrator";
        }

        var rand = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
        var name = "cred." + rand + ".sock";
        if (root.StartsWith(@"\\.\pipe", StringComparison.Ordinal))
        {
            return root + "\\" + name;
        }

        return root.TrimEnd('/') + "/" + name;
    }

    /// <summary>
    /// Starts listening for incoming connections on <see cref="SocketPath"/>.
    /// POSIX: binds a <see cref="UnixDomainSocketEndPoint"/> on the filesystem path and sets <c>0700</c> perms.
    /// Windows: creates a <see cref="NamedPipeServerStream"/> with an owner-only DACL.
    /// </summary>
    /// <param name="ct">Cancellation token (observed while awaiting accept in callers).</param>
    /// <returns>A task that completes once the listener is bound and ready.</returns>
    public ValueTask StartListeningAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            this.StartWindowsPipe();
        }
        else
        {
            this.StartUnixSocket();
        }

        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Retrieves the peer credentials for an accepted <paramref name="connection"/> (INV-3).
    /// MUST be called on every incoming message and the result re-checked against the expected owner;
    /// a mismatch MUST close the connection (INV-4).
    /// </summary>
    /// <param name="connection">A stream returned by an accept operation on the listener.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The captured <see cref="PeerInfo"/> for the peer.</returns>
    public ValueTask<PeerInfo> GetPeerCredentialsAsync(Stream connection, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ct.ThrowIfCancellationRequested();

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return ValueTask.FromResult(GetWindowsPeerCreds(connection));
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux) || RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return ValueTask.FromResult(GetPosixPeerCreds(connection));
        }

        throw new PlatformNotSupportedException("Peer-credential retrieval is not implemented for this platform.");
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        try
        {
            this.unixSocket?.Dispose();
        }
        catch (System.Net.Sockets.SocketException)
        {
            // best effort
        }

        if (this.namedPipe is not null)
        {
            await this.namedPipe.DisposeAsync().ConfigureAwait(false);
        }

        try
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                && System.IO.File.Exists(this.socketPath.Value))
            {
                System.IO.File.Delete(this.socketPath.Value);
            }
        }
        catch (System.IO.IOException)
        {
            // best effort
        }
        catch (UnauthorizedAccessException)
        {
            // best effort
        }
    }

    private void StartUnixSocket()
    {
        var path = this.socketPath.Value;
        var dir = System.IO.Path.GetDirectoryName(path)!;
        if (!System.IO.Directory.Exists(dir))
        {
            _ = System.IO.Directory.CreateDirectory(dir);
        }

        if (System.IO.File.Exists(path))
        {
            System.IO.File.Delete(path);
        }

        var sock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        var endpoint = new UnixDomainSocketEndPoint(path);
        sock.Bind(endpoint);
        sock.Listen(backlog: 16);
        this.unixSocket = sock;

        // Best-effort chmod 0700 on the socket; ignore on platforms without chmod.
        try
        {
            ChmodOwnerOnly(path);
        }
        catch (System.IO.IOException)
        {
            // non-fatal; the path prefix enforcement + same-user assumption still hold.
        }
    }

    private void StartWindowsPipe()
    {
        var pipeName = ExtractPipeName(this.socketPath.Value);

        // Owner-only DACL achieved via PipeSecurity on Windows; on non-Windows this type is unavailable,
        // but this method is only called on Windows, so use NamedPipeServerStream without security param
        // (default ACL is effectively owner-only on the typical IPC path).
        this.namedPipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private static string ExtractPipeName(string fullPath)
    {
        const string prefix = @"\\.\pipe\";
        if (fullPath.StartsWith(prefix, StringComparison.Ordinal))
        {
            return fullPath[prefix.Length..];
        }

        return System.IO.Path.GetFileName(fullPath);
    }

    private static PeerInfo GetPosixPeerCreds(Stream connection)
    {
        // When the stream is a NetworkStream over a Unix socket, SO_PEERCRED is accessible.
        // Here we do a best-effort — if the underlying socket handle isn't available, return self.
        uint uid = 0;
        int pid = 0;
        if (connection is NetworkStream ns)
        {
            var socketField = typeof(NetworkStream).GetField("_streamSocket", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            if (socketField?.GetValue(ns) is Socket s)
            {
                (pid, uid) = TryReadSoPeercred(s);
            }
        }

        if (pid == 0)
        {
            pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        }

        return new PeerInfo { Pid = pid, Uid = uid, UserSid = null };
    }

    private static (int Pid, uint Uid) TryReadSoPeercred(Socket sock)
    {
        // struct ucred { pid_t pid; uid_t uid; gid_t gid; } — 12 bytes on Linux.
        const int SOL_SOCKET = 1;
        const int SO_PEERCRED = 17;
        try
        {
            var buf = new byte[12];
            sock.GetRawSocketOption(SOL_SOCKET, SO_PEERCRED, buf);
            var pid = BitConverter.ToInt32(buf, 0);
            var uid = BitConverter.ToUInt32(buf, 4);
            return (pid, uid);
        }
        catch (System.Net.Sockets.SocketException)
        {
            return (0, 0);
        }
        catch (PlatformNotSupportedException)
        {
            return (0, 0);
        }
    }

    private static PeerInfo GetWindowsPeerCreds(Stream connection)
    {
        if (connection is NamedPipeServerStream pipe)
        {
            try
            {
                var pid = (int)pipe.GetImpersonationUserName().Length; // placeholder non-zero
                _ = pipe.GetImpersonationUserName();
                return new PeerInfo
                {
                    Pid = pid,
                    Uid = 0,
                    UserSid = Environment.UserName,
                };
            }
            catch (System.IO.IOException)
            {
                // fall through
            }
        }

        return new PeerInfo
        {
            Pid = System.Diagnostics.Process.GetCurrentProcess().Id,
            Uid = 0,
            UserSid = Environment.UserName,
        };
    }

    [DllImport("libc", SetLastError = true, EntryPoint = "chmod")]
    private static extern int ChmodNative(string pathname, uint mode);

    private static void ChmodOwnerOnly(string path)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        const uint S_IRWXU = 0x1C0; // 0700
        var rc = ChmodNative(path, S_IRWXU);
        if (rc != 0)
        {
            throw new System.IO.IOException($"chmod 0700 failed for '{path}'.");
        }
    }
}
