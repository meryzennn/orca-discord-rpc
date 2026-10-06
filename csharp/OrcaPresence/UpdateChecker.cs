using System;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace OrcaPresence
{
    public sealed class UpdateInfo
    {
        public bool HasUpdate { get; set; }
        public string LatestVersion { get; set; } = "";
        public string Url { get; set; } = "";
    }

    public static class UpdateChecker
    {
        public const string CurrentVersion = "0.1.0";
        public const string RepoUrl = "https://github.com/meryzennn/orca-discord-rpc";
        public const string ReleasesApiUrl = "https://api.github.com/repos/meryzennn/orca-discord-rpc/releases/latest";

        public static async Task<UpdateInfo> CheckForUpdateAsync(string currentVersion = CurrentVersion)
        {
            try
            {
                // Ensure TLS 1.2 is enabled for GitHub API on .NET Framework.
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

                using (var client = new WebClient())
                {
                    client.Headers.Add(HttpRequestHeader.UserAgent, "OrcaPresence/" + currentVersion);
                    var json = await client.DownloadStringTaskAsync(new Uri(ReleasesApiUrl)).ConfigureAwait(false);
                    return ParseRelease(json, currentVersion);
                }
            }
            catch
            {
                // Silently ignore network failures or offline status; update check must never crash the app.
                return new UpdateInfo();
            }
        }

        public static UpdateInfo ParseRelease(string json, string currentVersion)
        {
            try
            {
                var release = JsonSerializer.Deserialize<GitHubRelease>(json);
                if (release != null && !string.IsNullOrEmpty(release.TagName))
                {
                    if (IsNewerVersion(currentVersion, release.TagName!))
                    {
                        return new UpdateInfo
                        {
                            HasUpdate = true,
                            LatestVersion = release.TagName!,
                            Url = !string.IsNullOrEmpty(release.HtmlUrl) ? release.HtmlUrl! : RepoUrl + "/releases/latest"
                        };
                    }
                }
            }
            catch
            {
                // ignore
            }

            return new UpdateInfo();
        }

        public static bool IsNewerVersion(string current, string latest)
        {
            var curClean = CleanVersion(current);
            var latClean = CleanVersion(latest);

            if (Version.TryParse(curClean, out var curVer) && Version.TryParse(latClean, out var latVer))
            {
                return latVer > curVer;
            }

            return string.Compare(latClean, curClean, StringComparison.OrdinalIgnoreCase) > 0;
        }

        private static string CleanVersion(string v)
        {
            if (string.IsNullOrEmpty(v)) return "0.0.0";
            var trimmed = v.TrimStart('v', 'V').Trim();
            // In case of single dot e.g. "0.1", normalize to "0.1.0" for Version.TryParse
            var parts = trimmed.Split('.');
            if (parts.Length == 2) return trimmed + ".0";
            return trimmed;
        }

        private sealed class GitHubRelease
        {
            [JsonPropertyName("tag_name")]
            public string? TagName { get; set; }

            [JsonPropertyName("html_url")]
            public string? HtmlUrl { get; set; }
        }
    }
}
