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

            Console.WriteLine("OrcaPresence placeholder");
        }
    }
}
