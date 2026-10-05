using System;
using System.IO;

namespace OrcaPresence
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // Why: a debugging probe so the parser can be checked against real CLI output.
            if (args.Length == 2 && args[0] == "--parse")
            {
                var json = File.ReadAllText(args[1]);
                var worktrees = OrcaState.ParseWorktreePs(json);
                var active = OrcaState.SelectActiveWorktree(worktrees);
                Console.WriteLine("worktrees      : " + worktrees.Length);
                Console.WriteLine("active         : " + (active?.WorktreeId ?? "(none)"));
                Console.WriteLine("projectName    : " + (OrcaState.ProjectNameFor(active) ?? "(null)"));
                Console.WriteLine("branchName     : " + (OrcaState.BranchNameFor(active) ?? "(null)"));
                Console.WriteLine("openAgentCount : " + OrcaState.OpenAgentCount(active));
                Console.WriteLine("liveAgentCount : " + OrcaState.LiveAgents(active).Count);
                Console.WriteLine("hasActiveAgent : " + OrcaState.HasActiveAgent(active));
                Console.WriteLine("featuredAgent  : " + (OrcaState.FeaturedAgent(active)?.AgentType ?? "(null)"));
                return;
            }

            Console.WriteLine("OrcaPresence placeholder");
        }
    }
}
