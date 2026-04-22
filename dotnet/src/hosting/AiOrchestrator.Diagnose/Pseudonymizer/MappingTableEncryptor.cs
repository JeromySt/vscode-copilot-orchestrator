// <copyright file="MappingTableEncryptor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AiOrchestrator.Diagnose.Pseudonymizer;

/// <summary>
/// Serializes a mapping-table payload and encrypts it with AES-256-GCM,
/// wrapping the session key via RSA-OAEP-SHA-256 against a recipient public key (INV-3).
/// </summary>
internal static class MappingTableEncryptor
{
    // Wire format (little-endian):
    //   [magic "AIODIAG1"][fingerprintLen:int][fingerprint bytes]
    //   [wrappedKeyLen:int][wrappedKey]
    //   [nonceLen:int][nonce][tagLen:int][tag][cipherLen:int][cipher]
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("AIODIAG1");

    public static byte[] Encrypt(
        IReadOnlyDictionary<string, string> mapping,
        string recipientFingerprint,
        byte[] recipientPublicKeySpki)
    {
        ArgumentNullException.ThrowIfNull(mapping);
        ArgumentException.ThrowIfNullOrEmpty(recipientFingerprint);
        ArgumentNullException.ThrowIfNull(recipientPublicKeySpki);

        var json = JsonSerializer.Serialize(mapping, DiagnoseJson.Options);
        var plaintext = Encoding.UTF8.GetBytes(json);

        Span<byte> sessionKey = stackalloc byte[32];
        RandomNumberGenerator.Fill(sessionKey);
        Span<byte> nonce = stackalloc byte[12];
        RandomNumberGenerator.Fill(nonce);
        var tag = new byte[16];
        var cipher = new byte[plaintext.Length];
        using (var aes = new AesGcm(sessionKey, tag.Length))
        {
            aes.Encrypt(nonce, plaintext, cipher, tag);
        }

        byte[] wrapped;
        using (var rsa = RSA.Create())
        {
            rsa.ImportSubjectPublicKeyInfo(recipientPublicKeySpki, out _);
            wrapped = rsa.Encrypt(sessionKey.ToArray(), RSAEncryptionPadding.OaepSHA256);
        }

        using var ms = new MemoryStream();
        using (var bw = new BinaryWriter(ms, Encoding.UTF8, leaveOpen: true))
        {
            bw.Write(Magic);
            var fpBytes = Encoding.UTF8.GetBytes(recipientFingerprint);
            bw.Write(fpBytes.Length);
            bw.Write(fpBytes);
            bw.Write(wrapped.Length);
            bw.Write(wrapped);
            bw.Write(nonce.Length);
            bw.Write(nonce.ToArray());
            bw.Write(tag.Length);
            bw.Write(tag);
            bw.Write(cipher.Length);
            bw.Write(cipher);
        }

        return ms.ToArray();
    }

    public static IReadOnlyDictionary<string, string>? TryDecrypt(
        byte[] payload,
        string expectedFingerprint,
        byte[] privateKeyPkcs8)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentException.ThrowIfNullOrEmpty(expectedFingerprint);
        ArgumentNullException.ThrowIfNull(privateKeyPkcs8);

        using var ms = new MemoryStream(payload);
        using var br = new BinaryReader(ms, Encoding.UTF8, leaveOpen: true);
        var magic = br.ReadBytes(Magic.Length);
        if (magic.Length != Magic.Length)
        {
            return null;
        }

        for (var i = 0; i < Magic.Length; i++)
        {
            if (magic[i] != Magic[i])
            {
                return null;
            }
        }

        var fpLen = br.ReadInt32();
        var fpBytes = br.ReadBytes(fpLen);
        var fingerprint = Encoding.UTF8.GetString(fpBytes);
        if (!string.Equals(fingerprint, expectedFingerprint, StringComparison.Ordinal))
        {
            return null;
        }

        var wrappedLen = br.ReadInt32();
        var wrapped = br.ReadBytes(wrappedLen);
        var nonceLen = br.ReadInt32();
        var nonce = br.ReadBytes(nonceLen);
        var tagLen = br.ReadInt32();
        var tag = br.ReadBytes(tagLen);
        var cipherLen = br.ReadInt32();
        var cipher = br.ReadBytes(cipherLen);

        byte[] sessionKey;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportPkcs8PrivateKey(privateKeyPkcs8, out _);
            sessionKey = rsa.Decrypt(wrapped, RSAEncryptionPadding.OaepSHA256);
        }
        catch (CryptographicException)
        {
            return null;
        }

        var plaintext = new byte[cipher.Length];
        try
        {
            using var aes = new AesGcm(sessionKey, tag.Length);
            aes.Decrypt(nonce, cipher, tag, plaintext);
        }
        catch (CryptographicException)
        {
            return null;
        }

        var json = Encoding.UTF8.GetString(plaintext);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(json, DiagnoseJson.Options);
    }
}
