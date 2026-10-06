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
    }
}
