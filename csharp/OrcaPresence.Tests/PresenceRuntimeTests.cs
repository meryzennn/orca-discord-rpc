using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Xunit;

namespace OrcaPresence.Tests
{
    public class PresenceRuntimeTests
    {
        private sealed class Fake
        {
            public bool Orca = true;
            public bool ApplyFails;
            public readonly List<string> Applied = new List<string>();
            public int Cleared;
            public int Epoch;
            public Func<Task>? Tick;
            public readonly List<string> Logs = new List<string>();
        }

        private static PresenceRuntime Build(Fake f) => new PresenceRuntime(
            clientId: "1556649058657902712",
            pollMs: 15_000,
            useUploadedArt: false,
            log: line => f.Logs.Add(line),
            deps: new RuntimeDeps
            {
                IsOrcaRunning = () => Task.FromResult(f.Orca),
                ReadState = () => Task.FromResult<PresenceState?>(new PresenceState
                {
                    ProjectName = "orca",
                    AgentType = "claude",
                    OpenAgentCount = 1,
                    AgentActive = true
                }),
                Apply = activity =>
                {
                    if (f.ApplyFails)
                    {
                        return Task.FromResult(false);
                    }

                    f.Applied.Add(activity.Details);
                    return Task.FromResult(true);
                },
                Clear = () => { f.Cleared++; return Task.FromResult(true); },
                ConnectionGeneration = () => f.Epoch,
                Schedule = tick => { f.Tick = tick; return () => { }; }
            });

        [Fact]
        public async Task PushesWhileOrcaRuns()
        {
            var f = new Fake();
            await Build(f).StartAsync();
            Assert.Single(f.Applied);
            Assert.Equal("Claude", f.Applied[0]);
            Assert.True(f.Logs.Exists(l => l.Contains("Orca detected")));
        }

        [Fact]
        public async Task ClearsWhenOrcaClosesAndReportsIt()
        {
            var f = new Fake();
            var runtime = Build(f);
            await runtime.StartAsync();
            Assert.True(runtime.Status.OrcaRunning);

            f.Orca = false;
            await f.Tick!();
            Assert.Equal(1, f.Cleared);
            Assert.False(runtime.Status.OrcaRunning);
            Assert.True(f.Logs.Exists(l => l.Contains("Orca closed")));
        }

        [Fact]
        public async Task PausesAndResumesWithAFreshPush()
        {
            var f = new Fake();
            var runtime = Build(f);
            await runtime.StartAsync();
            await runtime.PauseAsync();
            Assert.True(runtime.Status.Paused);

            f.Applied.Clear();
            await runtime.StartAsync();
            Assert.Single(f.Applied);
            Assert.False(runtime.Status.Paused);
        }

        [Fact]
        public async Task RecordsAFailedPushWithoutThrowing()
        {
            var f = new Fake { ApplyFails = true };
            var runtime = Build(f);
            await runtime.StartAsync();
            Assert.NotNull(runtime.Status.LastError);
            Assert.Empty(f.Applied);
            Assert.True(f.Logs.Exists(l => l.Contains("push failed")));
        }

        [Fact]
        public async Task StopsPushingAfterStop()
        {
            var f = new Fake();
            var runtime = Build(f);
            await runtime.StartAsync();
            await runtime.StopAsync();
            await f.Tick!();
            Assert.Single(f.Applied);
        }

        [Fact]
        public async Task NotifiesSubscribersOfEveryTransition()
        {
            var f = new Fake();
            var runtime = Build(f);
            var seen = new List<bool>();
            runtime.StatusChanged += status => seen.Add(status.OrcaRunning);

            await runtime.StartAsync();
            f.Orca = false;
            await f.Tick!();

            Assert.Contains(true, seen);
            Assert.Contains(false, seen);
        }

        [Fact]
        public async Task OneThrowingSubscriberDoesNotStopTheOthers()
        {
            var f = new Fake();
            var runtime = Build(f);
            var reached = false;
            runtime.StatusChanged += _ => throw new InvalidOperationException("menu exploded");
            runtime.StatusChanged += _ => reached = true;

            await runtime.StartAsync();
            Assert.True(reached);
        }

        [Fact]
        public async Task LogsWhatItPushedSoAWrongPayloadIsDiagnosable()
        {
            var f = new Fake();
            await Build(f).StartAsync();
            Assert.True(f.Logs.Exists(l => l.Contains("pushed") && l.Contains("Claude")));
        }

        [Fact]
        public async Task LogsThePauseAndResumeSoTheBlankProfileCaseIsDiagnosable()
        {
            // Why pinned: pause-then-resume once pushed nothing and the profile stayed blank while
            // the menu claimed otherwise, and only the log made that visible.
            var f = new Fake();
            var runtime = Build(f);
            await runtime.StartAsync();
            await runtime.PauseAsync();
            await runtime.StartAsync();

            Assert.True(f.Logs.Exists(l => l.Contains("paused")), "expected a pause line");
            Assert.True(f.Logs.Exists(l => l.Contains("resuming")), "expected a resume line");
            // Two pushes: the start and the resume, with the clear in between.
            Assert.Equal(2, f.Applied.Count);
            Assert.Equal(1, f.Cleared);
        }
    }
}
