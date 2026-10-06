using Xunit;

namespace OrcaPresence.Tests
{
    public class UpdateCheckerTests
    {
        [Theory]
        [InlineData("0.1.0", "0.2.0", true)]
        [InlineData("v0.1.0", "v0.2.0", true)]
        [InlineData("0.1.0", "v0.1.1", true)]
        [InlineData("1.0.0", "1.0.0", false)]
        [InlineData("v0.1.0", "v0.1.0", false)]
        [InlineData("0.2.0", "0.1.0", false)]
        [InlineData("v1.0.0", "v0.9.9", false)]
        public void ComparesVersionsCorrectly(string current, string latest, bool expected)
        {
            Assert.Equal(expected, UpdateChecker.IsNewerVersion(current, latest));
        }

        [Fact]
        public void ParsesValidGitHubReleaseJson()
        {
            var json = @"{ ""tag_name"": ""v0.2.0"", ""html_url"": ""https://github.com/test/repo/releases/v0.2.0"" }";
            var result = UpdateChecker.ParseRelease(json, "0.1.0");

            Assert.True(result.HasUpdate);
            Assert.Equal("v0.2.0", result.LatestVersion);
            Assert.Equal("https://github.com/test/repo/releases/v0.2.0", result.Url);
        }

        [Fact]
        public void IgnoresSameOrOlderVersionInJson()
        {
            var json = @"{ ""tag_name"": ""v0.1.0"", ""html_url"": ""https://github.com/test/repo/releases/v0.1.0"" }";
            var result = UpdateChecker.ParseRelease(json, "0.1.0");

            Assert.False(result.HasUpdate);
        }

        [Fact]
        public void HandlesMalformedJsonGracefully()
        {
            var result = UpdateChecker.ParseRelease("not json", "0.1.0");
            Assert.False(result.HasUpdate);
        }
    }
}
