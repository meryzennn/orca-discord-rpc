using Xunit;

namespace OrcaPresence.Tests
{
    public class GitRemoteTests
    {
        [Theory]
        [InlineData("git@github.com:meryzennn/orca-discord-rpc.git", "https://github.com/meryzennn/orca-discord-rpc")]
        [InlineData("ssh://git@github.com/meryzennn/orca-discord-rpc.git", "https://github.com/meryzennn/orca-discord-rpc")]
        [InlineData("https://github.com/meryzennn/orca-discord-rpc.git", "https://github.com/meryzennn/orca-discord-rpc")]
        [InlineData("https://github.com/meryzennn/orca-discord-rpc", "https://github.com/meryzennn/orca-discord-rpc")]
        [InlineData("http://gitlab.example.com/group/repo.git", "http://gitlab.example.com/group/repo")]
        [InlineData(null, null)]
        [InlineData("", null)]
        [InlineData("   ", null)]
        public void NormalizesRemoteGitUrlsCorrectly(string? raw, string? expected)
        {
            Assert.Equal(expected, GitRemote.NormalizeGitUrl(raw));
        }

        [Fact]
        public void ParsesRemoteUrlFromGitConfigLines()
        {
            var configLines = new[]
            {
                "[core]",
                "\trepositoryformatversion = 0",
                "[remote \"origin\"]",
                "\turl = https://github.com/meryzennn/orca-discord-rpc.git",
                "\tfetch = +refs/heads/*:refs/remotes/origin/*",
                "[branch \"main\"]",
                "\tremote = origin"
            };

            var parsed = GitRemote.ParseRemoteUrlFromConfig(configLines);
            Assert.Equal("https://github.com/meryzennn/orca-discord-rpc.git", parsed);
        }

        [Fact]
        public void ResolvesRepoUrlForCurrentWorkspace()
        {
            var url = GitRemote.ResolveRepoUrl(System.IO.Directory.GetCurrentDirectory());
            Assert.Equal("https://github.com/meryzennn/orca-discord-rpc", url);
        }
    }
}
