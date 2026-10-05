using Xunit;

namespace OrcaPresence.Tests
{
    public class SmokeTests
    {
        [Fact]
        public void TheTestRunnerWorks()
        {
            Assert.Equal(2, 1 + 1);
        }

        [Fact]
        public void TheDefaultClientIdIsSane()
        {
            // Why: a Discord snowflake is 17-20 digits, and this value is what the app ships with.
            Assert.InRange(AppConfig.DefaultClientId.Length, 17, 20);
            Assert.All(AppConfig.DefaultClientId, c => Assert.True(char.IsDigit(c)));
        }
    }
}
