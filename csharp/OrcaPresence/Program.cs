using System;
using System.IO;
using System.Text;

namespace OrcaPresence
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // Why: a debugging probe so the payload can be compared against the TypeScript app.
            // Why guarded: a WinExe has no console when launched without one, and setting the
            // encoding then throws.
            try { Console.OutputEncoding = Encoding.UTF8; } catch (IOException) { }
            if (args.Length == 2 && args[0] == "--parse")
            {
                var json = File.ReadAllText(args[1]);
                var worktrees = OrcaState.ParseWorktreePs(json);
                var active = OrcaState.SelectActiveWorktree(worktrees);
                var featured = OrcaState.FeaturedAgent(active);
                var activity = Presence.BuildActivity(new PresenceInput
                {
                    ProjectName = OrcaState.ProjectNameFor(active),
                    AgentType = featured?.AgentType,
                    OpenAgentCount = OrcaState.OpenAgentCount(active),
                    AgentActive = OrcaState.HasActiveAgent(active),
                    BranchName = OrcaState.BranchNameFor(active),
                    StartedAt = DateTime.UtcNow,
                    UseUploadedArt = false
                });

                Console.WriteLine("worktrees      : " + worktrees.Length);
                Console.WriteLine("projectName    : " + (OrcaState.ProjectNameFor(active) ?? "(null)"));
                Console.WriteLine("branchName     : " + (OrcaState.BranchNameFor(active) ?? "(null)"));
                Console.WriteLine("featuredAgent  : " + (featured?.AgentType ?? "(null)"));
                Console.WriteLine("openAgentCount : " + OrcaState.OpenAgentCount(active));
                Console.WriteLine("agentActive    : " + OrcaState.HasActiveAgent(active));
                Console.WriteLine("--- payload ---");
                Console.WriteLine("details        : " + activity.Details);
                Console.WriteLine("state          : " + activity.State);
                Console.WriteLine("smallImageText : " + activity.SmallImageText);
                return;
            }

            // Why: a one-shot check that the hand-rolled IPC works against a live client.
            if (args.Length == 1 && args[0] == "--probe-discord")
            {
                var config = AppConfig.Load();
                using (var presence = new DiscordPresence(config.ClientId))
                {
                    var activity = new PresenceActivity
                    {
                        Details = "C# probe",
                        State = "orca-discord-rpc - Working",
                        StartTimestamp = DateTime.UtcNow,
                        LargeImageKey = "orca",
                        LargeImageText = "Orca",
                        SmallImageText = "Branch"
                    };
                    Console.WriteLine("apply  : " + presence.Apply(activity));
                    Console.WriteLine("connected: " + presence.IsConnected);
                    System.Threading.Thread.Sleep(1500);
                    Console.WriteLine("clear  : " + presence.Clear());
                    Console.WriteLine("generation: " + presence.ConnectionGeneration);
                }

                return;
            }

            Console.WriteLine("OrcaPresence placeholder");
        }
    }
}
