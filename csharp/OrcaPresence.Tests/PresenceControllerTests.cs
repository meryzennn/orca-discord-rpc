using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Xunit;

namespace OrcaPresence.Tests
{
    public class PresenceControllerTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 10, 5, 0, 0, 0, DateTimeKind.Utc);
        private static readonly DateTime T1 = T0.AddMinutes(1);

        private sealed class Harness
        {
            public readonly List<PresenceActivity> Applied = new List<PresenceActivity>();
            public int Cleared;
            public PresenceState? State;
            public DateTime Now = T0;
            public int Epoch;
            public bool FailApply;

            public PresenceController Build() => new PresenceController(
                readState: () => Task.FromResult(State),
                apply: a =>
                {
                    if (FailApply)
                    {
                        return Task.FromResult(false);
                    }

                    Applied.Add(a);
                    return Task.FromResult(true);
                },
                clear: () => { Cleared++; return Task.FromResult(true); },
                connectionEpoch: () => Epoch,
                now: () => Now,
                useUploadedArt: () => false);
        }

        private static PresenceState Running() => new PresenceState
        {
            ProjectName = "orca",
            AgentType = "claude",
            OpenAgentCount = 1,
            AgentActive = true
        };

        [Fact]
        public async Task PushesTheFirstReading()
        {
            var h = new Harness { State = Running() };
            await h.Build().PollAsync();
            Assert.Single(h.Applied);
            Assert.Equal("Agent: Claude · Working", h.Applied[0].Details);
            Assert.Equal("Folder: orca", h.Applied[0].State);
        }

        [Fact]
        public async Task DoesNotRepeatAnUnchangedReading()
        {
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            await c.PollAsync();
            await c.PollAsync();
            Assert.Single(h.Applied);
        }

        [Fact]
        public async Task AppliesWhenAnotherAgentAppears()
        {
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            h.State = new PresenceState
            {
                ProjectName = "orca", AgentType = "claude", OpenAgentCount = 2, AgentActive = true
            };
            await c.PollAsync();
            Assert.Equal(2, h.Applied.Count);
            Assert.Equal("Agent: Claude +1 · Working", h.Applied[1].Details);
        }

        [Fact]
        public async Task RetriesWhileApplyKeepsFailing()
        {
            // Why: Discord often starts after Orca, so a failure must not be remembered as sent.
            var h = new Harness { State = Running(), FailApply = true };
            var c = h.Build();
            await c.PollAsync();
            Assert.Empty(h.Applied);
            h.FailApply = false;
            await c.PollAsync();
            Assert.Single(h.Applied);
        }

        [Fact]
        public async Task RePushesAfterReset()
        {
            // Why: pause clears the activity, so the next push must not be deduped away.
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            c.Reset();
            await c.PollAsync();
            Assert.Equal(2, h.Applied.Count);
        }

        [Fact]
        public async Task RePushesWhenTheConnectionEpochAdvances()
        {
            // Why: Discord restarting drops the activity it showed.
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            h.Epoch = 1;
            await c.PollAsync();
            Assert.Equal(2, h.Applied.Count);
        }

        [Fact]
        public async Task ClearsWhenThereIsNoActiveWorktree()
        {
            var h = new Harness { State = null };
            await h.Build().PollAsync();
            Assert.Equal(1, h.Cleared);
            Assert.Empty(h.Applied);
        }

        [Fact]
        public async Task DoesNotClearRepeatedly()
        {
            var h = new Harness { State = null };
            var c = h.Build();
            await c.PollAsync();
            await c.PollAsync();
            Assert.Equal(1, h.Cleared);
        }

        [Fact]
        public async Task ResetsTheTimerAfterSessionClearsAndResumes()
        {
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            Assert.Equal(T0, h.Applied[0].StartTimestamp);

            h.State = null;
            await c.PollAsync();
            Assert.Equal(1, h.Cleared);

            h.Now = T1;
            h.State = Running();
            await c.PollAsync();
            Assert.Equal(2, h.Applied.Count);
            Assert.Equal(T1, h.Applied[1].StartTimestamp);
        }

        [Fact]
        public async Task KeepsTheTimerOnAProjectChange()
        {
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            h.Now = T1;
            h.State = new PresenceState
            {
                ProjectName = "other", AgentType = "claude", OpenAgentCount = 1, AgentActive = true
            };
            await c.PollAsync();
            Assert.Equal(T0, h.Applied[0].StartTimestamp);
            Assert.Equal(T0, h.Applied[1].StartTimestamp);
        }

        [Fact]
        public async Task KeepsTheTimerWhenOnlyTheAgentChanges()
        {
            var h = new Harness { State = Running() };
            var c = h.Build();
            await c.PollAsync();
            h.Now = T1;
            h.State = new PresenceState
            {
                ProjectName = "orca", AgentType = "codex", OpenAgentCount = 1, AgentActive = true
            };
            await c.PollAsync();
            Assert.Equal(T0, h.Applied[1].StartTimestamp);
        }

        [Fact]
        public async Task SurvivesAReaderThatThrows()
        {
            var calls = 0;
            var applied = 0;
            var controller = new PresenceController(
                readState: () =>
                {
                    calls++;
                    if (calls == 1)
                    {
                        throw new InvalidOperationException("orca CLI missing");
                    }

                    return Task.FromResult<PresenceState?>(Running());
                },
                apply: _ => { applied++; return Task.FromResult(true); },
                clear: () => Task.FromResult(true),
                connectionEpoch: null,
                now: () => T0,
                useUploadedArt: () => false);
            await controller.PollAsync();
            await controller.PollAsync();
            Assert.Equal(2, calls);
            Assert.Equal(1, applied);
        }
    }
}
