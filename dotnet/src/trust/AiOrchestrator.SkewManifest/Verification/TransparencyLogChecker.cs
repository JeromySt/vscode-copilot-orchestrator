// <copyright file="TransparencyLogChecker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.SkewManifest.Verification;

/// <summary>
/// Submits a <see cref="SkewManifest"/> hash to the configured transparency log endpoint
/// and records whether the log confirms inclusion (INV-8). When no URL is configured
/// the check is skipped and reports <see cref="TransparencyLogCheckResult.Included"/> = true.
/// </summary>
internal sealed class TransparencyLogChecker
{
#pragma warning disable CA1823, IDE0052
    private readonly IClock clock;
#pragma warning restore CA1823, IDE0052
    private readonly IHttpClientFactory http;
    private readonly IOptionsMonitor<SkewManifestOptions> opts;

    public TransparencyLogChecker(IHttpClientFactory http, IClock clock, IOptionsMonitor<SkewManifestOptions> opts)
    {
        this.http = http;
        this.clock = clock;
        this.opts = opts;
    }

    public async ValueTask<TransparencyLogCheckResult> CheckAsync(SkewManifest mfst, CancellationToken ct)
    {
        var options = this.opts.CurrentValue;
        if (string.IsNullOrEmpty(options.TransparencyLogUrl))
        {
            return new TransparencyLogCheckResult { Included = true, FailureReason = null };
        }

        byte[] payload = CanonicalPayload.ComputeForSignature(mfst);
        byte[] hash = SHA256.HashData(payload);
        var hashHex = Convert.ToHexString(hash);

        using var client = this.http.CreateClient("skew-manifest-transparency");
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, options.TransparencyLogUrl)
            {
                Content = JsonContent.Create(new TransparencyLogRequest { ManifestHash = hashHex }),
            };
            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new TransparencyLogCheckResult
                {
                    Included = false,
                    FailureReason = $"Transparency log returned HTTP {(int)resp.StatusCode}",
                };
            }

            var body = await resp.Content.ReadFromJsonAsync<TransparencyLogResponse>(ct).ConfigureAwait(false);
            if (body is null)
            {
                return new TransparencyLogCheckResult { Included = false, FailureReason = "Empty response." };
            }

            return new TransparencyLogCheckResult
            {
                Included = body.Included,
                FailureReason = body.Included ? null : (body.Reason ?? "Not included."),
            };
        }
        catch (HttpRequestException ex)
        {
            return new TransparencyLogCheckResult { Included = false, FailureReason = ex.Message };
        }
        catch (TaskCanceledException ex)
        {
            return new TransparencyLogCheckResult { Included = false, FailureReason = ex.Message };
        }
    }

    private sealed record TransparencyLogRequest
    {
        [JsonPropertyName("manifestHash")]
        public required string ManifestHash { get; init; }
    }

    private sealed record TransparencyLogResponse
    {
        [JsonPropertyName("included")]
        public bool Included { get; init; }

        [JsonPropertyName("proof")]
        public string? Proof { get; init; }

        [JsonPropertyName("reason")]
        public string? Reason { get; init; }
    }
}
