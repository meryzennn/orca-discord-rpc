using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace OrcaPresence
{
    internal static class Program
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);
        private const int AttachParentProcess = -1;

        /// <summary>
        /// Why a global mutex: two copies would run two presences fighting over the profile, which
        /// shows up as the activity flickering between two states.
        /// </summary>
        private const string SingleInstanceName = "Global\\OrcaDiscordPresence";

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0)
            {
                AttachConsole(AttachParentProcess);
                try
                {
                    var stdout = Console.OpenStandardOutput();
                    if (stdout != Stream.Null)
                    {
                        Console.SetOut(new StreamWriter(stdout, Encoding.UTF8) { AutoFlush = true });
                    }
                }
                catch
                {
                    // ignore
                }
            }

            // Why its own command: turning the login start on and off or checking status from CLI.
            if (args.Length > 0 && Autostart.Parse(args) != AutostartCommand.None)
            {
                return RunAutostartCommand(args);
            }

            // Why: probes exist so the app can be checked against the real CLI, Discord and Orca
            // without a window. They are development-only and exit on their own.
            if (args.Length > 0 && args[0].StartsWith("--probe", StringComparison.Ordinal))
            {
                return Probes.Run(args);
            }

            if (args.Length == 2 && args[0] == "--parse")
            {
                return Probes.Parse(args[1]);
            }

            using (var mutex = new Mutex(initiallyOwned: true, name: SingleInstanceName, createdNew: out var isFirst))
            {
                if (!isFirst)
                {
                    // Why: notify the user so they know the app is already active in their system tray.
                    MessageBox.Show(
                        "Orca Discord Presence is already running in the system tray.",
                        TrayStatus.AppDisplayName,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

                var config = AppConfig.Load();
                using (var host = new TrayHost(config))
                {
                    host.Start();
                    // Why an ApplicationContext and not a Form: the tray icon is the only UI, so no
                    // window exists and the app can never take focus.
                    Application.Run(new ApplicationContext());
                }

                return 0;
            }
        }

        /// <summary>
        /// Turns the login start on or off or prints status. Targets the current executable.
        /// </summary>
        private static int RunAutostartCommand(string[] args)
        {
            var autostart = new Autostart();
            var target = Autostart.CurrentExecutablePath();

            switch (Autostart.Parse(args))
            {
                case AutostartCommand.Enable:
                    autostart.Enable(target);
                    Console.WriteLine("start with Windows: on");
                    Console.WriteLine("target: " + target);
                    return 0;

                case AutostartCommand.Disable:
                    autostart.Disable();
                    Console.WriteLine("start with Windows: off");
                    return 0;

                case AutostartCommand.Status:
                default:
                    Console.WriteLine("this exe: " + target);
                    Console.WriteLine("start with Windows: " + (autostart.Value ?? "(off)"));
                    Console.WriteLine("points at this exe: " + autostart.PointsAt(target));
                    return 0;
            }
        }
    }

    /// <summary>
    /// Why these exist and write to a file: this is a WinExe, so a console may not be attached and
    /// stdout through a pipe is unreliable. A file gives a deterministic record to check.
    /// </summary>
    internal static class Probes
    {
        private static string ProbeLogPath() => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "orca-discord-rpc",
            "probe.log");

        private static Action<string> ProbeLogger(List<string> captured)
        {
            try
            {
                File.WriteAllText(ProbeLogPath(), string.Empty);
            }
            catch
            {
                // ignore
            }

            return line =>
            {
                captured.Add(line);
                try
                {
                    File.AppendAllText(ProbeLogPath(), DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                }
                catch
                {
                    // ignore
                }
            };
        }

        public static int Parse(string jsonPath)
        {
            var worktrees = OrcaState.ParseWorktreePs(File.ReadAllText(jsonPath));
            var active = OrcaState.SelectActiveWorktree(worktrees);
            var featured = OrcaState.FeaturedAgent(active);
            var activity = Presence.BuildActivity(new PresenceInput
            {
                ProjectName = OrcaState.ProjectNameFor(active),
                AgentType = featured?.AgentType,
                OpenAgentCount = OrcaState.OpenAgentCount(active),
                AgentActive = OrcaState.HasActiveAgent(active),
                BranchName = OrcaState.BranchNameFor(active),
                StartedAt = DateTime.UtcNow
            });

            var lines = new List<string>
            {
                "projectName    : " + (OrcaState.ProjectNameFor(active) ?? "(null)"),
                "branchName     : " + (OrcaState.BranchNameFor(active) ?? "(null)"),
                "featuredAgent  : " + (featured?.AgentType ?? "(null)"),
                "openAgentCount : " + OrcaState.OpenAgentCount(active),
                "agentActive    : " + OrcaState.HasActiveAgent(active),
                "details        : " + activity.Details,
                "state          : " + activity.State,
                "smallImageText : " + activity.SmallImageText
            };
            File.WriteAllText(jsonPath + ".csharp.txt", string.Join(Environment.NewLine, lines), new UTF8Encoding(false));
            return 0;
        }

        public static int Run(string[] args)
        {
            var captured = new List<string>();
            var log = ProbeLogger(captured);
            var config = AppConfig.Load();

            switch (args[0])
            {
                case "--probe-orca":
                    log("orcaRunning: " + OrcaProcess.IsOrcaRunning());
                    var state = OrcaReader.ReadPresenceState();
                    log("state: " + (state == null
                        ? "(none)"
                        : state.ProjectName + " | agent=" + state.AgentType + " | count=" +
                          state.OpenAgentCount + " | active=" + state.AgentActive + " | branch=" + state.BranchName));
                    return 0;

                case "--probe-discord":
                    using (var presence = new DiscordPresence(config.ClientId))
                    {
                        log("apply: " + presence.Apply(SampleActivity()));
                        Thread.Sleep(1500);
                        log("clear: " + presence.Clear());
                        log("generation: " + presence.ConnectionGeneration);
                    }

                    return 0;

                case "--probe-parity":
                    // Why this one: pause-then-resume pushed nothing once, and the profile stayed
                    // blank while the menu claimed the agent was showing.
                    var runtime = new PresenceRuntime(
                        config.ClientId, config.PollMs, config.UseUploadedArt, log);
                    runtime.StartAsync().GetAwaiter().GetResult();
                    log("-- after start");
                    runtime.PauseAsync().GetAwaiter().GetResult();
                    log("-- after pause");
                    runtime.StartAsync().GetAwaiter().GetResult();
                    log("-- after resume");
                    runtime.Dispose();

                    var pushes = captured.Count(line => line.StartsWith("pushed:", StringComparison.Ordinal));
                    log("RESULT pushes=" + pushes);
                    return pushes >= 2 ? 0 : 1;

                default:
                    return 2;
            }
        }

        private static PresenceActivity SampleActivity() => new PresenceActivity
        {
            Details = "C# probe",
            State = "orca-discord-rpc",
            StartTimestamp = DateTime.UtcNow,
            LargeImageText = "Orca"
        };
    }
}
