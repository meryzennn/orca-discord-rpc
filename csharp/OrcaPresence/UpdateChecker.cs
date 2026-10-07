using System;
using System.Diagnostics;
using System.IO;
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
        public string? DownloadUrl { get; set; }
    }

    public static class UpdateChecker
    {
        public const string CurrentVersion = "0.1.6";
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
                        string? downloadUrl = null;
                        if (release.Assets != null)
                        {
                            foreach (var a in release.Assets)
                            {
                                if (a != null && !string.IsNullOrEmpty(a.Name) &&
                                    a.Name!.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) &&
                                    !string.IsNullOrEmpty(a.BrowserDownloadUrl))
                                {
                                    downloadUrl = a.BrowserDownloadUrl;
                                    break;
                                }
                            }
                        }

                        if (string.IsNullOrEmpty(downloadUrl))
                        {
                            downloadUrl = RepoUrl + "/releases/download/" + release.TagName + "/OrcaPresence-windows.zip";
                        }

                        return new UpdateInfo
                        {
                            HasUpdate = true,
                            LatestVersion = release.TagName!,
                            Url = !string.IsNullOrEmpty(release.HtmlUrl) ? release.HtmlUrl! : RepoUrl + "/releases/latest",
                            DownloadUrl = downloadUrl
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

        /// <summary>
        /// Downloads the release zip and invokes a background PowerShell script to cleanly
        /// unpack, replace files, and restart the executable after this process exits.
        /// </summary>
        public static async Task<bool> DownloadAndInstallUpdateAsync(UpdateInfo update, string targetExe, int currentPid = 0)
        {
            if (string.IsNullOrEmpty(update.DownloadUrl))
            {
                return false;
            }

            if (currentPid <= 0)
            {
                try
                {
                    currentPid = Process.GetCurrentProcess().Id;
                }
                catch
                {
                    currentPid = 0;
                }
            }

            var tempZip = Path.Combine(Path.GetTempPath(), "OrcaPresence-update.zip");
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                using (var client = new WebClient())
                {
                    client.Headers.Add(HttpRequestHeader.UserAgent, "OrcaPresence/" + CurrentVersion);
                    await client.DownloadFileTaskAsync(new Uri(update.DownloadUrl!), tempZip).ConfigureAwait(false);
                }

                if (!File.Exists(tempZip) || new FileInfo(tempZip).Length < 1000)
                {
                    return false;
                }

                var targetDir = Path.GetDirectoryName(targetExe);
                if (string.IsNullOrEmpty(targetDir))
                {
                    return false;
                }

                // PowerShell command: wait for the old PID to completely terminate, ensure mutex and file locks are released,
                // retry unzipping in case of temporary locks, start new exe, and clean up temp zip.
                var waitCmd = currentPid > 0
                    ? "$ErrorActionPreference = 'SilentlyContinue'; Wait-Process -Id " + currentPid + " -Timeout 10; Stop-Process -Id " + currentPid + " -Force; "
                    : "$ErrorActionPreference = 'SilentlyContinue'; Start-Sleep -Milliseconds 1200; ";

                var psArgs = "-NoProfile -WindowStyle Hidden -Command \"" +
                    waitCmd +
                    "Start-Sleep -Milliseconds 500; " +
                    "for ($i = 0; $i -lt 5; $i++) { try { Expand-Archive -Force -LiteralPath '" + tempZip.Replace("'", "''") + "' -DestinationPath '" + targetDir.Replace("'", "''") + "'; break } catch { Start-Sleep -Milliseconds 500 } }; " +
                    "Start-Process -FilePath '" + targetExe.Replace("'", "''") + "'; " +
                    "Remove-Item -LiteralPath '" + tempZip.Replace("'", "''") + "'\"";

                Process.Start(new ProcessStartInfo("powershell.exe", psArgs)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                });

                return true;
            }
            catch
            {
                try
                {
                    if (File.Exists(tempZip))
                    {
                        File.Delete(tempZip);
                    }
                }
                catch
                {
                    // ignore
                }

                return false;
            }
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

            [JsonPropertyName("assets")]
            public GitHubAsset[]? Assets { get; set; }
        }

        private sealed class GitHubAsset
        {
            [JsonPropertyName("name")]
            public string? Name { get; set; }

            [JsonPropertyName("browser_download_url")]
            public string? BrowserDownloadUrl { get; set; }
        }
    }
}
