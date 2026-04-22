// <copyright file="HostAllowlistChecker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Options;

namespace AiOrchestrator.Credentials.Allowlist;

/// <summary>Matches a URL's host against <see cref="CredentialOptions.AllowedHostSuffixes"/> (CRED-ACL-1).</summary>
internal sealed class HostAllowlistChecker
{
    private readonly IOptionsMonitor<CredentialOptions> opts;

    public HostAllowlistChecker(IOptionsMonitor<CredentialOptions> opts)
    {
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
    }

    /// <summary>Returns <see langword="true"/> iff <paramref name="repoUrl"/>'s host matches any allowed suffix (case-insensitive).</summary>
    /// <param name="repoUrl">The URL to check.</param>
    /// <returns><see langword="true"/> if allowed; otherwise <see langword="false"/>.</returns>
    public bool IsAllowed(Uri repoUrl)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        var host = repoUrl.Host;
        if (string.IsNullOrEmpty(host))
        {
            return false;
        }

        var allowed = this.opts.CurrentValue.AllowedHostSuffixes;
        foreach (var suffix in allowed)
        {
            if (string.IsNullOrEmpty(suffix))
            {
                continue;
            }

            if (host.Equals(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            // Suffix match: host must end with ".<suffix>" to avoid "evilgithub.com" matching "github.com".
            if (host.Length > suffix.Length &&
                host.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Builds a <see cref="CredentialHostNotAllowedException"/> capturing the current allowlist snapshot.</summary>
    /// <param name="repoUrl">The rejected URL.</param>
    /// <returns>The populated exception.</returns>
    public CredentialHostNotAllowedException CreateException(Uri repoUrl) =>
        new(repoUrl, this.opts.CurrentValue.AllowedHostSuffixes);
}
