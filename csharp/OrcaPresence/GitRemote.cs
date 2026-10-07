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

            var raw = ReadGitConfigFile(workspacePath!) ?? QueryGitRemote(workspacePath!);
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

        public static string? ReadGitConfigFile(string directory)
        {
            try
            {
                var gitPath = Path.Combine(directory, ".git");
                string configPath;
                if (Directory.Exists(gitPath))
                {
                    configPath = Path.Combine(gitPath, "config");
                }
                else if (File.Exists(gitPath))
                {
                    var firstLine = File.ReadAllLines(gitPath);
                    if (firstLine.Length > 0 && firstLine[0].Trim().StartsWith("gitdir:", StringComparison.OrdinalIgnoreCase))
                    {
                        var gitDir = firstLine[0].Trim().Substring(7).Trim();
                        if (!Path.IsPathRooted(gitDir))
                        {
                            gitDir = Path.GetFullPath(Path.Combine(directory, gitDir));
                        }
                        configPath = Path.Combine(gitDir, "config");
                        if (!File.Exists(configPath))
                        {
                            var parentConfig = Path.GetFullPath(Path.Combine(gitDir, "..", "..", "config"));
                            if (File.Exists(parentConfig))
                            {
                                configPath = parentConfig;
                            }
                        }
                    }
                    else
                    {
                        return null;
                    }
                }
                else
                {
                    return null;
                }

                if (!File.Exists(configPath))
                {
                    return null;
                }

                return ParseRemoteUrlFromConfig(File.ReadAllLines(configPath));
            }
            catch
            {
                return null;
            }
        }

        public static string? ParseRemoteUrlFromConfig(IEnumerable<string> lines)
        {
            var inOriginSection = false;
            foreach (var rawLine in lines)
            {
                var line = rawLine.Trim();
                if (line.StartsWith("[", StringComparison.Ordinal))
                {
                    inOriginSection = line.Equals("[remote \"origin\"]", StringComparison.OrdinalIgnoreCase);
                    continue;
                }

                if (inOriginSection && line.StartsWith("url", StringComparison.OrdinalIgnoreCase))
                {
                    var eq = line.IndexOf('=');
                    if (eq >= 0 && eq < line.Length - 1)
                    {
                        return line.Substring(eq + 1).Trim();
                    }
                }
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
