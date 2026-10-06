using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace OrcaPresence
{
    /// <summary>Is the Orca desktop app running?</summary>
    public static class OrcaProcess
    {
        /// <summary>
        /// Why the exe name: Windows reports `Orca.exe` for every Electron child process too, so
        /// any match means the app is up. Nothing else on Windows is called Orca.
        /// </summary>
        public static bool IsOrcaRunning()
        {
            try
            {
                var processes = Process.GetProcessesByName("Orca");
                foreach (var process in processes)
                {
                    process.Dispose();
                }

                return processes.Length > 0;
            }
            catch
            {
                // Why false on failure: an unverifiable probe must not read as "Orca is open", or a
                // stale presence would be left on the profile forever.
                return false;
            }
        }
    }

    /// <summary>Runs the Orca CLI and turns its output into a presence state.</summary>
    public static class OrcaReader
    {
        private const int TimeoutMs = 10_000;

        public static PresenceState? ReadPresenceState()
        {
            var stdout = RunWorktreePs();
            if (stdout == null)
            {
                return null;
            }

            var worktrees = OrcaState.ParseWorktreePs(stdout);
            var active = OrcaState.SelectActiveWorktree(worktrees);
            if (active == null)
            {
                return null;
            }

            var featured = OrcaState.FeaturedAgent(active);
            return new PresenceState
            {
                ProjectName = OrcaState.ProjectNameFor(active),
                AgentType = featured?.AgentType,
                OpenAgentCount = OrcaState.OpenAgentCount(active),
                AgentActive = OrcaState.HasActiveAgent(active),
                BranchName = OrcaState.BranchNameFor(active),
                RepoUrl = GitRemote.ResolveRepoUrl(active.Path)
            };
        }

        /// <summary>Null when the CLI is missing or does not answer in time.</summary>
        public static string? RunWorktreePs()
        {
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = "orca.exe",
                    // Why a string and not ArgumentList: ArgumentList is .NET Core only, and this
                    // app targets the in-box .NET Framework. The arguments are constant, so there
                    // is nothing to escape here.
                    Arguments = "worktree ps --json",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8
                };

                using (var process = Process.Start(info))
                {
                    if (process == null)
                    {
                        return null;
                    }

                    var stdout = process.StandardOutput.ReadToEnd();
                    if (!process.WaitForExit(TimeoutMs))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch
                        {
                            // ignore
                        }

                        return null;
                    }

                    return process.ExitCode == 0 ? stdout : null;
                }
            }
            catch
            {
                // Why swallowed: a missing CLI or a spawn failure is a retry, not a crash.
                return null;
            }
        }
    }
}
