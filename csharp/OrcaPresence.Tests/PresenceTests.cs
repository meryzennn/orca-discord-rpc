using System;
using Xunit;

namespace OrcaPresence.Tests
{
    public class PresenceTests
    {
        private static readonly DateTime Started = new DateTime(2026, 10, 5, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void NamesTheAgentAndTheFolderWithStatus()
        {
            var a = Build("orca-discord-rpc", "claude", 1);
            Assert.Equal("Agent: Claude", a.Details);
            Assert.Equal("Folder: orca-discord-rpc · Working", a.State);
        }

        [Fact]
        public void AppendsTheOtherOpenAgents()
        {
            Assert.Equal("Agent: Codex +1", Build("orca", "codex", 2).Details);
            Assert.Equal("Agent: Claude +2", Build("orca", "claude", 3).Details);
            Assert.Equal("Agent: Codex", Build("orca", "codex", 1).Details);
        }

        [Fact]
        public void ShowsIdleWhenBetweenTurns()
        {
            Assert.Equal("Folder: orca · Idle", Build("orca", "claude", 1, active: false).State);
        }

        [Fact]
        public void FallsBackToUsingOrcaWithNoAgent()
        {
            var a = Build(null, null, 0);
            Assert.Equal("Using Orca", a.Details);
            Assert.Equal("Orca", a.State);
            // Why null: agent logos are gone and nothing is uploaded, so the large slot is empty.
            Assert.Null(a.LargeImageKey);
        }

        [Fact]
        public void PutsTheFolderAloneOnLineTwoWithoutAnAgent()
        {
            Assert.Equal("Folder: orca", Build("orca", null, 0).State);
        }

        [Fact]
        public void PutsTheBranchOnTheIconTooltip()
        {
            Assert.Equal("feat/x", Build("orca", "claude", 1, branch: "feat/x").SmallImageText);
            Assert.Equal("Branch", Build("orca", "claude", 1).SmallImageText);
        }

        [Fact]
        public void UsesTheBranchAssetKeyWhenArtworkIsUploaded()
        {
            var a = Build("orca", "claude", 1, uploaded: true);
            Assert.Equal("git-branch", a.SmallImageKey);
            Assert.Null(a.SmallImageUrl);
            // Why: agent logos were removed, so the large slot is the application's own art.
            Assert.Equal("orca", a.LargeImageKey);
        }

        [Fact]
        public void UsesTheBranchUrlWhenNothingIsUploaded()
        {
            var a = Build("orca", "claude", 1);
            Assert.NotNull(a.SmallImageUrl);
            Assert.Null(a.SmallImageKey);
        }

        [Fact]
        public void NamesNoAgentArtworkAtAll()
        {
            // Why pinned: Discord renders only registered art and takes no external image, so a
            // per-agent logo could never work without an upload step nobody wanted.
            var a = Build("orca", "codex", 1);
            Assert.Null(a.LargeImageKey);
            Assert.Equal("Agent: Codex", a.Details);
        }

        [Fact]
        public void FallsBackToTheOrcaAssetForAnUnknownAgent()
        {
            var a = Build("orca", "some-in-house-agent", 1, uploaded: true);
            Assert.Equal("Agent: Some In House Agent", a.Details);
            Assert.Equal("orca", a.LargeImageKey);
        }

        [Fact]
        public void OmitsAOneCharacterFolderRatherThanFailingTheUpdate()
        {
            // Why: Discord rejects any field shorter than 2 characters and fails the whole update.
            Assert.Equal("Working", Build("x", "claude", 1).State);
        }

        [Fact]
        public void OmitsAOneCharacterAgentName()
        {
            Assert.Equal("", Build("orca", "q", 1).Details);
        }

        [Fact]
        public void NeverEmitsASingleCharacterField()
        {
            var a = Build("x", "q", 1);
            foreach (var value in new[] { a.Details, a.State, a.LargeImageText, a.SmallImageText })
            {
                if (value != null)
                {
                    Assert.True(value.Length == 0 || value.Length >= 2, "too short: " + value);
                }
            }
        }

        [Fact]
        public void KeepsEveryFieldWithinDiscordLimits()
        {
            var a = Build(new string('x', 200), "claude", 12);
            Assert.InRange(a.Details.Length, 2, 128);
            Assert.InRange(a.State.Length, 0, 128);
        }

        [Fact]
        public void TruncatesALongFolderName()
        {
            var a = Build(new string('x', 250), null, 0);
            Assert.Equal(100, a.State.Length);
        }

        [Fact]
        public void CollapsesWhitespaceInNames()
        {
            var a = Build("my  project\n\ttwo", null, 0);
            Assert.Equal("Folder: my project two", a.State);
        }

        [Fact]
        public void KeepsTheAgentVisibleWhenTheLineWouldOverflow()
        {
            var a = Build(new string('x', 120), "claude", 1);
            Assert.True(a.State.Length <= 128);
            Assert.EndsWith("Working", a.State);
        }

        [Fact]
        public void TitleCasesAnUnknownAgent()
        {
            Assert.Equal("Some In House Agent", Presence.AgentDisplayName("some-in-house-agent"));
            Assert.Equal("OpenCode", Presence.AgentDisplayName("opencode"));
            Assert.Equal("Claude", Presence.AgentDisplayName("claude-agent-teams"));
            Assert.Equal("Qwen Code", Presence.AgentDisplayName("qwen-code"));
        }

        [Fact]
        public void IncognitoHidesBranchFolderAndButtons()
        {
            var a = Presence.BuildActivity(new PresenceInput
            {
                ProjectName = "super-secret-project",
                AgentType = "claude",
                OpenAgentCount = 1,
                AgentActive = true,
                BranchName = "feature/confidential",
                RepoUrl = "https://github.com/myorg/private-repo",
                Incognito = true,
                StartedAt = Started
            });

            Assert.Equal("Agent: Claude", a.Details);
            Assert.Equal("Folder: Private Project · Working", a.State);
            Assert.Null(a.SmallImageText);
            Assert.Null(a.SmallImageKey);
            Assert.Null(a.SmallImageUrl);
            Assert.Null(a.Buttons);
        }

        [Fact]
        public void IncognitoIdleShowsPrivateProjectIdle()
        {
            var a = Presence.BuildActivity(new PresenceInput
            {
                ProjectName = "secret",
                AgentType = "codex",
                OpenAgentCount = 1,
                AgentActive = false,
                Incognito = true,
                StartedAt = Started
            });

            Assert.Equal("Agent: Codex", a.Details);
            Assert.Equal("Folder: Private Project · Idle", a.State);
        }

        [Fact]
        public void ShowsViewRepositoryButtonWhenNotIncognito()
        {
            var a = Presence.BuildActivity(new PresenceInput
            {
                ProjectName = "orca-discord-rpc",
                AgentType = "claude",
                OpenAgentCount = 1,
                AgentActive = true,
                BranchName = "main",
                RepoUrl = "https://github.com/meryzennn/orca-discord-rpc",
                Incognito = false,
                StartedAt = Started
            });

            Assert.Equal("Agent: Claude", a.Details);
            Assert.Equal("Folder: orca-discord-rpc · Working", a.State);
            Assert.NotNull(a.Buttons);
            Assert.Single(a.Buttons!);
            Assert.Equal("View Repository", a.Buttons![0].Label);
            Assert.Equal("https://github.com/meryzennn/orca-discord-rpc", a.Buttons![0].Url);
        }

        [Fact]
        public void CreateBadgeIconProducesValidIcon()
        {
            using (var baseIcon = System.Drawing.SystemIcons.Application)
            using (var badge = TrayHost.CreateBadgeIcon(baseIcon))
            {
                Assert.NotNull(badge);
                Assert.True(badge.Width > 0);
                Assert.True(badge.Height > 0);
            }
        }

        private static PresenceActivity Build(string? project, string? agent, int count,
            bool active = true, string? branch = null, bool uploaded = false) =>
            Presence.BuildActivity(new PresenceInput
            {
                ProjectName = project,
                AgentType = agent,
                OpenAgentCount = count,
                AgentActive = active,
                BranchName = branch,
                StartedAt = Started,
                UseUploadedArt = uploaded
            });
    }
}
