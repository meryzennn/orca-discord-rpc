using System;
using System.IO;
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
            Assert.Contains("HKEY_CURRENT_USER", RegistryAutostartStore.KeyPath);
            Assert.DoesNotContain("HKEY_LOCAL_MACHINE", RegistryAutostartStore.KeyPath);
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

        [Fact]
        public void CopiesEveryFileTheAppNeedsToRun()
        {
            // Why pinned: copying only the exe produced an install that threw
            // FileNotFoundException on System.Text.Json at startup, so it could never run.
            var directory = Path.Combine(Path.GetTempPath(), "orca-install-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                File.WriteAllText(Path.Combine(directory, "OrcaPresence.exe"), "exe");
                File.WriteAllText(Path.Combine(directory, "System.Text.Json.dll"), "dll");
                File.WriteAllText(Path.Combine(directory, "OrcaPresence.pdb"), "symbols");

                var files = SelfInstall.FilesToCopy(directory);

                Assert.Contains("OrcaPresence.exe", files);
                Assert.Contains("System.Text.Json.dll", files);
                // A symbol file is not needed to run.
                Assert.DoesNotContain("OrcaPresence.pdb", files);
            }
            finally
            {
                Directory.Delete(directory, recursive: true);
            }
        }

        [Fact]
        public void InstallsBesideItsDependencies()
        {
            // The dependency assemblies must land in the same directory as the exe.
            Assert.Equal(
                Path.GetDirectoryName(SelfInstall.InstallTargetPath()),
                SelfInstall.InstallTargetDirectory());
        }

        [Fact]
        public void ReportsStalenessByComparingWriteTimes()
        {
            // Why pinned: an install that was never refreshed kept running the old build at login
            // while a manual launch used the new one, so a feature existed in one copy only.
            var directory = Path.Combine(Path.GetTempPath(), "orca-stale-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                var source = Path.Combine(directory, "source.exe");
                var installed = Path.Combine(directory, "installed.exe");
                File.WriteAllText(source, "new");
                File.WriteAllText(installed, "old");

                File.SetLastWriteTimeUtc(installed, DateTime.UtcNow.AddMinutes(-5));
                Assert.True(SelfInstall.IsInstalledCopyStale(source, installed));

                File.SetLastWriteTimeUtc(installed, DateTime.UtcNow.AddMinutes(5));
                Assert.False(SelfInstall.IsInstalledCopyStale(source, installed));
            }
            finally
            {
                Directory.Delete(directory, recursive: true);
            }
        }

        [Fact]
        public void AMissingInstallCountsAsStale()
        {
            // Nothing installed means there is certainly nothing current.
            var missing = Path.Combine(Path.GetTempPath(), "orca-missing-" + Guid.NewGuid().ToString("N") + ".exe");
            Assert.True(SelfInstall.IsInstalledCopyStale(@"C:\does\not\exist\OrcaPresence.exe", missing));
        }
    }
}
