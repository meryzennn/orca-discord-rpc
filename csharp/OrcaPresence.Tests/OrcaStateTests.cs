using System.Linq;
using Xunit;

namespace OrcaPresence.Tests
{
    public class OrcaStateTests
    {
        private const long T = 1_760_000_000_000L;

        [Fact]
        public void ReadsWorktreesOutOfTheEnvelope()
        {
            var parsed = OrcaState.ParseWorktreePs(
                Envelope("{\"worktreeId\":\"a\",\"isActive\":false},{\"worktreeId\":\"b\",\"isActive\":true}"));
            Assert.Equal(2, parsed.Length);
            Assert.Equal("b", OrcaState.SelectActiveWorktree(parsed)?.WorktreeId);
        }

        [Fact]
        public void ToleratesMalformedInput()
        {
            Assert.Empty(OrcaState.ParseWorktreePs("not json"));
            Assert.Empty(OrcaState.ParseWorktreePs("{\"ok\":false}"));
        }

        [Fact]
        public void TreatsAMissingAgentsArrayAsEmpty()
        {
            var worktrees = OrcaState.ParseWorktreePs(Envelope("{\"worktreeId\":\"a\"}"));
            Assert.Empty(worktrees[0].Agents);
        }

        [Fact]
        public void DropsDoneAgentsFromTheLiveSet()
        {
            var w = One("{\"state\":\"done\",\"agentType\":\"gemini\"}," +
                        "{\"state\":\"working\",\"agentType\":\"codex\"}");
            Assert.Single(OrcaState.LiveAgents(w));
            Assert.True(OrcaState.HasActiveAgent(w));
        }

        [Fact]
        public void CountsAnAgentBetweenTurnsAsOpen()
        {
            // Why: counting only live agents made a two-agent workspace report one.
            var w = One("{\"state\":\"done\",\"agentType\":\"codex\"}," +
                        "{\"state\":\"working\",\"agentType\":\"claude\"}");
            Assert.Equal(2, OrcaState.OpenAgentCount(w));
        }

        [Fact]
        public void IgnoresARowWithNoAgentType()
        {
            var w = One("{\"state\":\"working\"},{\"state\":\"working\",\"agentType\":\"claude\"}");
            Assert.Equal(1, OrcaState.OpenAgentCount(w));
            Assert.Empty(OrcaState.LiveAgents(One("{\"state\":\"working\"}")));
        }

        [Fact]
        public void PrefersALiveAgentOverANewerIdleOne()
        {
            var w = One("{\"state\":\"working\",\"agentType\":\"codex\",\"stateStartedAt\":" + (T + 10) + "}," +
                        "{\"state\":\"done\",\"agentType\":\"claude\",\"stateStartedAt\":" + (T + 99) + "}");
            Assert.Equal("codex", OrcaState.FeaturedAgent(w)?.AgentType);
        }

        [Fact]
        public void FallsBackToAnIdleAgentWhenNothingIsLive()
        {
            var w = One("{\"state\":\"done\",\"agentType\":\"codex\",\"stateStartedAt\":" + (T + 10) + "}," +
                        "{\"state\":\"done\",\"agentType\":\"claude\",\"stateStartedAt\":" + (T + 30) + "}");
            Assert.Equal("claude", OrcaState.FeaturedAgent(w)?.AgentType);
        }

        [Fact]
        public void IgnoresAHydratedRowWithASyntheticClock()
        {
            var w = One("{\"state\":\"working\",\"agentType\":\"codex\",\"stateStartedAt\":" + (T + 10) + "}," +
                        "{\"state\":\"working\",\"agentType\":\"claude\",\"stateStartedAt\":3}");
            Assert.Equal("codex", OrcaState.FeaturedAgent(w)?.AgentType);
        }

        [Fact]
        public void ReturnsNoAgentWhenThereIsNone()
        {
            Assert.Null(OrcaState.FeaturedAgent(One("")));
            Assert.Null(OrcaState.FeaturedAgent(null));
        }

        [Fact]
        public void UsesTheFolderNameFromThePath()
        {
            var w = Worktree("\"displayName\":\"feat/thing\",\"path\":\"D:/coding/orca-discord-rpc\"");
            Assert.Equal("orca-discord-rpc", OrcaState.ProjectNameFor(w));
        }

        [Fact]
        public void PrefersAPinnedDisplayNameOverThePath()
        {
            var w = Worktree("\"displayName\":\"My Label\",\"path\":\"D:/coding/repo\"," +
                             "\"meta\":{\"displayNameIsPinned\":true}");
            Assert.Equal("My Label", OrcaState.ProjectNameFor(w));
        }

        [Fact]
        public void FallsBackToTheDisplayNameWhenThereIsNoPath()
        {
            Assert.Equal("only-label", OrcaState.ProjectNameFor(Worktree("\"displayName\":\"only-label\"")));
            Assert.Null(OrcaState.ProjectNameFor(Worktree("")));
        }

        [Fact]
        public void StripsTheRefsHeadsPrefixFromTheBranch()
        {
            Assert.Equal("feat/x", OrcaState.BranchNameFor(Worktree("\"branch\":\"refs/heads/feat/x\"")));
            Assert.Equal("main", OrcaState.BranchNameFor(Worktree("\"branch\":\"main\"")));
            Assert.Null(OrcaState.BranchNameFor(Worktree("\"branch\":\"\"")));
        }

        private static string Envelope(string worktrees) =>
            "{\"ok\":true,\"result\":{\"worktrees\":[" + worktrees + "]}}";

        /// <summary>A worktree JSON object whose `agents` array holds the given rows.</summary>
        private static OrcaWorktree One(string agents) => Worktree("\"agents\":[" + agents + "]");

        /// <summary>A worktree JSON object with the given fields, no agents.</summary>
        private static OrcaWorktree Worktree(string fields)
        {
            var body = fields.Length == 0 ? "\"isActive\":true" : "\"isActive\":true," + fields;
            return OrcaState.ParseWorktreePs(Envelope("{" + body + "}"))[0];
        }
    }
}
