using System;
using Xunit;

namespace OrcaPresence.Tests
{
    public class SelfInstallTests
    {
        [Fact]
        public void RecognisesTheCommands()
        {
            Assert.Equal(SelfInstallCommand.Install, SelfInstall.Parse(new[] { "--install" }));
            Assert.Equal(SelfInstallCommand.Uninstall, SelfInstall.Parse(new[] { "--uninstall" }));
            Assert.Equal(SelfInstallCommand.Status, SelfInstall.Parse(new[] { "--status" }));
        }

        [Fact]
        public void TreatsAnythingElseAsNoCommand()
        {
            Assert.Equal(SelfInstallCommand.None, SelfInstall.Parse(new string[0]));
            Assert.Equal(SelfInstallCommand.None, SelfInstall.Parse(new[] { "--probe-orca" }));
            Assert.Equal(SelfInstallCommand.None, SelfInstall.Parse(new[] { "--nonsense" }));
        }

        [Fact]
        public void PutsTheAutostartEntryUnderTheUsersOwnKey()
        {
            // Why per-user: an install must not need an administrator.
            Assert.Contains("HKEY_CURRENT_USER", SelfInstall.AutostartKeyPath);
            Assert.DoesNotContain("HKEY_LOCAL_MACHINE", SelfInstall.AutostartKeyPath);
        }

        [Fact]
        public void InstallsIntoTheUsersLocalAppData()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            Assert.StartsWith(local, SelfInstall.InstallTargetPath());
            Assert.EndsWith("OrcaPresence.exe", SelfInstall.InstallTargetPath());
        }

        [Fact]
        public void ReportsWhetherArgumentsAreAnInstallCommand()
        {
            Assert.True(SelfInstall.IsInstallCommand(new[] { "--install" }));
            Assert.False(SelfInstall.IsInstallCommand(new[] { "--probe-discord" }));
        }
    }
}
