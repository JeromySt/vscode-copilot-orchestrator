// <copyright file="TrustFileVerifier.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Models.Paths;
using Org.BouncyCastle.Math.EC.Rfc8032;

namespace AiOrchestrator.Plugins.Trust;

/// <summary>
/// Verifies the integrity and trustworthiness of the plugin trust file (TRUST-ACL-1, TRUST-ACL-2).
/// Checks file permissions (owner-only) and validates the Ed25519 signature over the canonical payload.
/// </summary>
internal sealed class TrustFileVerifier
{
    private readonly IFileSystem fs;

    /// <summary>Initializes a new instance of the <see cref="TrustFileVerifier"/> class.</summary>
    /// <param name="fs">The file system abstraction used to open the trust file.</param>
    public TrustFileVerifier(IFileSystem fs)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    /// <summary>
    /// Returns <see langword="true"/> if the trust file at <paramref name="trustFile"/> has
    /// owner-only permissions (0600 on Unix, owner-only DACL on Windows).
    /// </summary>
    /// <param name="trustFile">Absolute path to the trust file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> if permissions are acceptable; otherwise <see langword="false"/>.</returns>
    public ValueTask<bool> IsTrustFileValidAsync(AbsolutePath trustFile, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (!File.Exists(trustFile.Value))
        {
            return new ValueTask<bool>(false);
        }

        bool valid;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            valid = IsOwnerOnlyDaclWindows(trustFile.Value);
        }
        else
        {
            valid = IsOwnerOnlyPosix(trustFile.Value);
        }

        return new ValueTask<bool>(valid);
    }

    /// <summary>
    /// Loads the trust file from <paramref name="trustFile"/>, verifies its Ed25519 signature
    /// against <paramref name="expectedSignerPubKey"/>, and returns the deserialized
    /// <see cref="TrustFile"/> if valid.
    /// </summary>
    /// <param name="trustFile">Absolute path to the trust file.</param>
    /// <param name="expectedSignerPubKey">32-byte Ed25519 public key of the authorized signer.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The verified trust file.</returns>
    /// <exception cref="InvalidOperationException">Thrown if the signature is invalid or the file is malformed.</exception>
    public async ValueTask<TrustFile> LoadAndVerifyAsync(AbsolutePath trustFile, byte[] expectedSignerPubKey, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(expectedSignerPubKey);

        var json = await this.fs.ReadAllTextAsync(trustFile, ct).ConfigureAwait(false);

        TrustFile? tf;
        try
        {
            tf = JsonSerializer.Deserialize(json, PluginsJsonContext.Default.TrustFile);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Trust file is malformed: {ex.Message}", ex);
        }

        if (tf is null)
        {
            throw new InvalidOperationException("Trust file deserialized to null.");
        }

        // Compute canonical payload (the file content without the signature field).
        var payload = ComputeCanonicalPayload(tf);
        if (!VerifyEd25519(payload, tf.Ed25519Signature, expectedSignerPubKey))
        {
            throw new InvalidOperationException("Trust file Ed25519 signature is invalid (TRUST-ACL-2).");
        }

        return tf;
    }

    internal static byte[] ComputeCanonicalPayload(TrustFile tf)
    {
        // Canonical payload is the JSON of the trust file with ed25519Signature omitted.
        var payload = new CanonicalTrustPayload(tf.TrustedPlugins, tf.SignedAt, tf.SignerKeyId);
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, PluginsJsonContext.Default.CanonicalTrustPayload));
    }

    private static bool VerifyEd25519(byte[] message, byte[] signature, byte[] publicKey)
    {
        if (signature.Length != Ed25519Signer.SignatureSize || publicKey.Length != Ed25519Signer.PublicKeySize)
        {
            return false;
        }

        return Ed25519.Verify(signature, 0, publicKey, 0, message, 0, message.Length);
    }

    [SupportedOSPlatform("windows")]
    private static bool IsOwnerOnlyDaclWindows(string path)
    {
        try
        {
            var fileInfo = new FileInfo(path);
            var security = fileInfo.GetAccessControl();
            var owner = WindowsIdentity.GetCurrent().User;
            if (owner is null)
            {
                return false;
            }

            var rules = security.GetAccessRules(includeExplicit: true, includeInherited: true, targetType: typeof(SecurityIdentifier));
            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType == AccessControlType.Allow
                    && rule.IdentityReference is SecurityIdentifier sid
                    && !sid.Equals(owner))
                {
                    // Another principal has access — reject.
                    return false;
                }
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsOwnerOnlyPosix(string path)
    {
        try
        {
            // Stat the file and check that mode & 0177 == 0 (i.e., only owner has any bits set).
            // We use File.GetUnixFileMode (available in .NET 7+).
            var mode = (int)File.GetUnixFileMode(path);

            // 0600 = 0b110_000_000 → bits 6-7 set, everything else zero.
            // Reject if any group or other bits are set.
            const int groupOtherMask = 0b000_111_111; // octal 077
            return (mode & groupOtherMask) == 0;
        }
        catch
        {
            return false;
        }
    }
}
