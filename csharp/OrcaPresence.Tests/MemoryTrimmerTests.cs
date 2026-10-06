using Xunit;

namespace OrcaPresence.Tests
{
    public class MemoryTrimmerTests
    {
        [Fact]
        public void TrimsWorkingSetWithoutThrowing()
        {
            var result = MemoryTrimmer.Trim();
            Assert.True(result);
        }
    }
}
