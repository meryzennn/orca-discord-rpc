using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace OrcaPresence
{
    public static class GitRemote
    {
        private static readonly Dictionary<string, string?> Cache = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        public static string? ResolveRepoUrl(string? workspacePath)
        {
            if (string.IsNullOrWhiteSpace(workspacePath) || !Directory.Exists(workspacePath))
            {
                return null;
            }

            lock (Cache)
            {
                if (Cache.TryGetValue(workspacePath!, out var cached))
                {
                    return cached;
                }
            }

            var raw = QueryGitRemote(workspacePath!);
            var clean = NormalizeGitUrl(raw);

            lock (Cache)
            {
                Cache[workspacePath!] = clean;
            }

            return clean;
        }

        public static string? NormalizeGitUrl(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return null;
            }

            var trimmed = raw!.Trim();

            // e.g. git@github.com:owner/repo.git
            if (trimmed.StartsWith("git@", StringComparison.OrdinalIgnoreCase))
            {
                var colon = trimmed.IndexOf(':');
                if (colon > 0 && colon < trimmed.Length - 1)
                {
                    var host = trimmed.Substring(4, colon - 4);
                    var path = trimmed.Substring(colon + 1);
                    if (path.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
                    {
                        path = path.Substring(0, path.Length - 4);
                    }

                    return "https://" + host + "/" + path.TrimStart('/');
                }
            }

            // e.g. ssh://git@github.com/owner/repo.git
            if (trimmed.StartsWith("ssh://git@", StringComparison.OrdinalIgnoreCase))
            {
                var stripped = trimmed.Substring("ssh://git@".Length);
                var slash = stripped.IndexOf('/');
                if (slash > 0 && slash < stripped.Length - 1)
                {
                    var host = stripped.Substring(0, slash);
                    var path = stripped.Substring(slash + 1);
                    if (path.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
                    {
                        path = path.Substring(0, path.Length - 4);
                    }

                    return "https://" + host + "/" + path.TrimStart('/');
                }
            }

            // e.g. https://github.com/owner/repo.git or http://...
            if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                if (trimmed.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
                {
                    trimmed = trimmed.Substring(0, trimmed.Length - 4);
                }

                if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
                {
                    return uri.Scheme + "://" + uri.Host + uri.PathAndQuery.TrimEnd('/');
                }

                return trimmed;
            }

            return null;
        }

        private static string? QueryGitRemote(string directory)
        {
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = "git",
                    Arguments = "-C \"" + directory + "\" config --get remote.origin.url",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (var p = Process.Start(info))
                {
                    if (p != null && p.WaitForExit(1500))
                    {
                        if (p.ExitCode == 0)
                        {
                            var outText = p.StandardOutput.ReadToEnd().Trim();
                            return string.IsNullOrEmpty(outText) ? null : outText;
                        }
                    }
                }
            }
            catch
            {
                // git CLI missing or timed out
            }

            return null;
        }
    }
}
