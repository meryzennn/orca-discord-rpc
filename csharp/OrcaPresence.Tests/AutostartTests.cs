using System;
using System.Collections.Generic;
using Xunit;

namespace OrcaPresence.Tests
{
    public class AutostartTests
    {
        /// <summary>An in-memory stand-in for the registry, so tests never touch the real one.</summary>
        private sealed class FakeStore : IAutostartStore
        {
            public string? Value;
            public int Writes;
            public int Deletes;

            public string? Read() => Value;

            public void Write(string value)
            {
                Value = value;
                Writes++;
            }

            public void Delete()
            {
                Value = null;
                Deletes++;
            }
        }

        private const string Exe = @"C:\Users\me\AppData\Local\orca-discord-rpc\OrcaPresence.exe";

        [Fact]
        public void EnablesByPointingTheEntryAtTheExe()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);

            autostart.Enable(Exe);

            Assert.True(autostart.IsEnabled);
            Assert.Equal(1, store.Writes);
        }

        [Fact]
        public void QuotesAPathWithSpacesSoTheShellDoesNotSplitIt()
        {
            var store = new FakeStore();
            new Autostart(store).Enable(@"C:\Program Files\Orca Presence\OrcaPresence.exe");

            Assert.Equal("\"C:\\Program Files\\Orca Presence\\OrcaPresence.exe\"", store.Value);
        }

        [Fact]
        public void DisablingRemovesTheEntry()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);
            autostart.Enable(Exe);

            autostart.Disable();

            Assert.False(autostart.IsEnabled);
            Assert.Equal(1, store.Deletes);
        }

        [Fact]
        public void DisablingTwiceIsHarmless()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);

            autostart.Disable();
            autostart.Disable();

            Assert.False(autostart.IsEnabled);
        }

        [Fact]
        public void ReportsWhetherItPointsAtAGivenExe()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);
            autostart.Enable(Exe);

            Assert.True(autostart.PointsAt(Exe));
            // Why case-insensitive: Windows paths are, and the registry echoes what it was given.
            Assert.True(autostart.PointsAt(Exe.ToUpperInvariant()));
            Assert.False(autostart.PointsAt(@"C:\somewhere\else.exe"));
        }

        [Fact]
        public void ReportsNotPointingAnywhereWhenUnset()
        {
            var autostart = new Autostart(new FakeStore());
            Assert.False(autostart.IsEnabled);
            Assert.False(autostart.PointsAt(Exe));
        }

        [Fact]
        public void TheEntryValueIsReadableForStatusOutput()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);
            autostart.Enable(Exe);

            Assert.Contains("OrcaPresence.exe", autostart.Value!);
        }

        [Fact]
        public void ParsesTheEnableAndDisableWords()
        {
            Assert.Equal(AutostartCommand.Enable, Autostart.Parse(new[] { "enable" }));
            Assert.Equal(AutostartCommand.Disable, Autostart.Parse(new[] { "disable" }));
            Assert.Equal(AutostartCommand.Status, Autostart.Parse(new[] { "status" }));
        }

        [Fact]
        public void ParsesTheDocumentedTwoWordForm()
        {
            // Why pinned: the CLI is documented as `autostart disable`, and a parser that only read
            // the first word did nothing while the command looked like it had run.
            Assert.Equal(AutostartCommand.Enable, Autostart.Parse(new[] { "autostart", "enable" }));
            Assert.Equal(AutostartCommand.Disable, Autostart.Parse(new[] { "autostart", "disable" }));
            Assert.Equal(AutostartCommand.Status, Autostart.Parse(new[] { "autostart", "status" }));
        }

        [Fact]
        public void ABareAutostartWordIsNoCommand()
        {
            Assert.Equal(AutostartCommand.None, Autostart.Parse(new[] { "autostart" }));
        }

        [Fact]
        public void AnythingElseIsNoCommand()
        {
            Assert.Equal(AutostartCommand.None, Autostart.Parse(new string[0]));
            Assert.Equal(AutostartCommand.None, Autostart.Parse(new[] { "toggle" }));
            Assert.Equal(AutostartCommand.None, Autostart.Parse(new[] { "on" }));
        }

        [Fact]
        public void TogglesInPlaceForAMenuCheckbox()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);

            autostart.Toggle(Exe);
            Assert.True(autostart.IsEnabled);

            autostart.Toggle(Exe);
            Assert.False(autostart.IsEnabled);
        }

        [Fact]
        public void EnablingAnAlreadyEnabledEntryDoesNotRewriteIt()
        {
            var store = new FakeStore();
            var autostart = new Autostart(store);
            autostart.Enable(Exe);

            autostart.Enable(Exe);

            Assert.Equal(1, store.Writes);
        }
    }
}
