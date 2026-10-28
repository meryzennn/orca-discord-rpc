using System;
using System.IO;
using Xunit;

namespace OrcaPresence.Tests
{
    public class AgentModelTests : IDisposable
    {
        private readonly string _home = Path.Combine(Path.GetTempPath(), "orca-model-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            try
            {
                Directory.Delete(_home, true);
            }
            catch
            {
                // ignore
            }
        }

        [Theory]
        [InlineData("claude-opus-5-5", "Claude Opus 5.5")]
        [InlineData("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5")]
        [InlineData("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet")]
        [InlineData("claude-opus-4-6[1m]", "Claude Opus 4.6")]
        [InlineData("anthropic/claude-haiku-4-5", "Claude Haiku 4.5")]
        [InlineData("gpt-5.1-codex-max", "GPT-5.1 Codex Max")]
        [InlineData("gpt-4o", "GPT-4o")]
        [InlineData("cmdcode", "Cmdcode")]
        public void NamesTheModelTheWayPeopleWriteIt(string raw, string expected)
        {
            Assert.Equal(expected, AgentModel.PrettyName(raw));
        }

        [Theory]
        [InlineData("D:/coding/orca-discord-rpc", "D--coding-orca-discord-rpc")]
        [InlineData(@"D:\coding\Ngecor\.claude\worktrees\feat", "D--coding-Ngecor--claude-worktrees-feat")]
        [InlineData("/home/me/proj", "-home-me-proj")]
        public void BuildsTheClaudeProjectFolderName(string path, string expected)
        {
            Assert.Equal(expected, AgentModel.ClaudeProjectSlug(path));
        }

        [Fact]
        public void TakesTheLastRealModelAndSkipsSyntheticOnes()
        {
            var log = "{\"message\":{\"model\":\"claude-sonnet-4-5\"}}\n" +
                      "{\"message\":{\"model\":\"claude-opus-5-5\"}}\n" +
                      "{\"message\":{\"model\":\"<synthetic>\"}}\n" +
                      // Why: a model name quoted inside a message is escaped and must not count.
                      "{\"content\":\"use \\\"model\\\":\\\"gpt-4o\\\"\"}\n";
            Assert.Equal("claude-opus-5-5", AgentModel.LastModelIn(log));
            Assert.Null(AgentModel.LastModelIn("{}"));
        }

        [Fact]
        public void ReadsClaudeFromTheNewestSessionOfTheWorktree()
        {
            var dir = Path.Combine(_home, ".claude", "projects", "d--coding-app");
            Directory.CreateDirectory(dir);
            var older = Path.Combine(dir, "old.jsonl");
            File.WriteAllText(older, "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5\"}}\n");
            File.SetLastWriteTimeUtc(older, DateTime.UtcNow.AddHours(-1));
            File.WriteAllText(Path.Combine(dir, "new.jsonl"), "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\"}}\n");

            // Why a lowercase folder and an uppercase path: Windows mixes D: and d: for the same folder.
            Assert.Equal("Claude Opus 5.5", AgentModel.Find("claude", "D:/coding/app", _ => null, _home));
        }

        [Fact]
        public void ReadsCodexFromTheSessionWhoseFolderMatches()
        {
            var day = Path.Combine(_home, ".codex", "sessions", "2026", "10", "08");
            Directory.CreateDirectory(day);
            File.WriteAllText(Path.Combine(day, "rollout-a.jsonl"),
                "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"D:\\\\coding\\\\app\"}}\n" +
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.1-codex\"}}\n");
            File.WriteAllText(Path.Combine(day, "rollout-b.jsonl"),
                "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"D:\\\\coding\\\\other\"}}\n" +
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-4o\"}}\n");

            Assert.Equal("GPT-5.1 Codex", AgentModel.Find("codex", "D:/coding/app", _ => null, _home));
        }

        [Fact]
        public void HonoursTheConfigFolderOverride()
        {
            var custom = Path.Combine(_home, "custom-claude");
            var dir = Path.Combine(custom, "projects", "D--coding-app");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "s.jsonl"), "{\"message\":{\"model\":\"claude-haiku-4-5\"}}\n");

            Func<string, string?> env = name => name == "CLAUDE_CONFIG_DIR" ? custom : null;
            Assert.Equal("Claude Haiku 4.5", AgentModel.Find("claude", "D:/coding/app", env, _home));
        }

        [Fact]
        public void KnowsNothingForAnUnsupportedAgentOrAMissingLog()
        {
            Assert.Null(AgentModel.Find("opencode", "D:/coding/app", _ => null, _home));
            Assert.Null(AgentModel.Find("claude", "D:/coding/app", _ => null, _home));
            Assert.Null(AgentModel.Find("codex", "D:/coding/app", _ => null, _home));
            Assert.Null(AgentModel.Find(null, "D:/coding/app", _ => null, _home));
            Assert.Null(AgentModel.Find("claude", null, _ => null, _home));
        }
    }
}
