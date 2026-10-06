using System;
using Xunit;

namespace OrcaPresence.Tests
{
    public class TrayStatusTests
    {
        private static RuntimeStatus Healthy() => new RuntimeStatus
        {
            DiscordConnected = true,
            OrcaRunning = true,
            LastActivity = new PresenceActivity
            {
                Details = "Claude",
                State = "orca · Working",
                StartTimestamp = new DateTime(2026, 10, 5, 0, 0, 0, DateTimeKind.Utc)
            }
        };

        [Fact]
        public void ReportsAHealthyActivity()
        {
            var s = TrayStatus.Describe(Healthy());
            Assert.Equal(TrayTone.Ok, s.Tone);
            Assert.Equal("Claude", s.Headline);
            Assert.Equal("orca · Working", s.Detail);
        }

        [Fact]
        public void ReportsDiscordMissing()
        {
            var status = Healthy();
            status.DiscordConnected = false;
            var s = TrayStatus.Describe(status);
            Assert.Equal(TrayTone.Waiting, s.Tone);
            Assert.Contains("Discord", s.Headline);
        }

        [Fact]
        public void ReportsOrcaClosed()
        {
            var status = Healthy();
            status.OrcaRunning = false;
            status.LastActivity = null;
            var s = TrayStatus.Describe(status);
            Assert.Equal(TrayTone.Idle, s.Tone);
            Assert.Contains("Orca", s.Headline);
        }

        [Fact]
        public void ReportsPausedAboveHealthy()
        {
            var status = Healthy();
            status.Paused = true;
            var s = TrayStatus.Describe(status);
            Assert.Equal(TrayTone.Idle, s.Tone);
            Assert.Contains("paused", s.Headline, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void LetsAnErrorOutrankEverything()
        {
            var status = Healthy();
            status.Paused = true;
            status.DiscordConnected = false;
            status.LastError = "boom";
            var s = TrayStatus.Describe(status);
            Assert.Equal(TrayTone.Error, s.Tone);
            Assert.Equal("boom", s.Detail);
            Assert.Contains("Problem", s.Headline);
        }

        [Fact]
        public void ReportsNoAgentWhenOrcaIsUpButNothingRuns()
        {
            var status = Healthy();
            status.LastActivity = null;
            var s = TrayStatus.Describe(status);
            Assert.Contains("agent", s.Headline, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void BuildsATooltipNamingTheAppAndTheState()
        {
            var s = TrayStatus.Describe(Healthy());
            Assert.Contains("Orca Discord Presence", s.Tooltip);
            Assert.Contains("Claude", s.Tooltip);
        }

        [Fact]
        public void NeverReturnsAHeadlineUnderTwoCharacters()
        {
            // Why: the headline is reused in text fields that Discord rejects below 2 characters.
            foreach (var status in new[]
                     {
                         Healthy(),
                         With(s => s.Paused = true),
                         With(s => s.OrcaRunning = false),
                         With(s => s.DiscordConnected = false),
                         With(s => s.LastError = "x"),
                         With(s => s.LastActivity = null)
                     })
            {
                Assert.True(TrayStatus.Describe(status).Headline.Length >= 2);
            }
        }

        private static RuntimeStatus With(Action<RuntimeStatus> change)
        {
            var status = Healthy();
            change(status);
            return status;
        }
    }
}
