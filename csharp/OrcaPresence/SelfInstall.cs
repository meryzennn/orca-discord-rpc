using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace OrcaPresence
{
    public enum SelfInstallCommand
    {
        None,
        Install,
        Uninstall,
        Status
    }

    /// <summary>
    /// Moves the app somewhere durable and runs it from there. No installer and no administrator:
    /// the copy lands in the user's own AppData and the autostart entry is theirs too.
    /// </summary>
    public static class SelfInstall
    {
        private const string InstallDirectoryName = "orca-discord-rpc";
        private const string InstalledExeName = "OrcaPresence.exe";

        public static bool IsInstallCommand(string[] args) =>
            Parse(args) != SelfInstallCommand.None;

        public static SelfInstallCommand Parse(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                return SelfInstallCommand.None;
            }

            switch (args[0])
            {
                case "--install": return SelfInstallCommand.Install;
                case "--uninstall": return SelfInstallCommand.Uninstall;
                case "--status": return SelfInstallCommand.Status;
                default: return SelfInstallCommand.None;
            }
        }

        /// <summary>The durable copy this install owns.</summary>
        public static string InstallTargetPath()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, InstallDirectoryName, InstalledExeName);
        }

        /// <summary>The directory the install owns; the exe needs its dependency DLLs beside it.</summary>
        public static string InstallTargetDirectory() => Path.GetDirectoryName(InstallTargetPath())!;

        /// <summary>
        /// Every file the published app needs: the exe plus its dependency assemblies.
        ///
        /// Why the whole set and not just the exe: copying the exe alone produced an install that
        /// threw FileNotFoundException on System.Text.Json at startup, so it could never run.
        /// </summary>
        public static IReadOnlyList<string> FilesToCopy(string sourceDirectory)
        {
            var files = new List<string>();
            foreach (var path in Directory.GetFiles(sourceDirectory))
            {
                var name = Path.GetFileName(path);
                // Why skipped: a symbol file is not needed to run.
                if (name.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                files.Add(name);
            }

            files.Sort(StringComparer.OrdinalIgnoreCase);
            return files;
        }

        /// <summary>
        /// Whether the installed copy is older than the exe asking to install.
        ///
        /// Why this matters: an install only refreshed when it was run again, so a user who had
        /// installed once kept running the old build at every login while their manual launches
        /// used the new one — which showed up as a menu row existing in one copy and not the other.
        /// </summary>
        public static bool IsInstalledCopyStale(string sourceExecutablePath, string? installedPath = null)
        {
            var target = installedPath ?? InstallTargetPath();
            if (!File.Exists(target))
            {
                return true;
            }

            var source = File.GetLastWriteTimeUtc(sourceExecutablePath);
            var installed = File.GetLastWriteTimeUtc(target);
            // Why a second of slack: a copy written in the same operation can land marginally
            // older than its source, and that must not read as stale forever.
            return source > installed.AddSeconds(1);
        }

        public static int Run(string[] args)
        {
            switch (Parse(args))
            {
                case SelfInstallCommand.Install:
                    return Install();
                case SelfInstallCommand.Uninstall:
                    return Uninstall();
                case SelfInstallCommand.Status:
                    return Status();
                default:
                    return 0;
            }
        }

        private static int Install()
        {
            var source = ExecutablePath();
            var sourceDirectory = Path.GetDirectoryName(source)!;
            var target = InstallTargetPath();
            var targetDirectory = InstallTargetDirectory();
            Directory.CreateDirectory(targetDirectory);

            var copied = 0;
            // Why compared by directory: installing from the published folder into the install
            // folder must copy, but reinstalling over itself must not.
            if (!SameDirectory(sourceDirectory, targetDirectory))
            {
                foreach (var name in FilesToCopy(sourceDirectory))
                {
                    File.Copy(
                        Path.Combine(sourceDirectory, name),
                        Path.Combine(targetDirectory, name),
                        overwrite: true);
                    copied++;
                }
            }

            var autostart = new Autostart();
            autostart.Enable(target);

            Console.WriteLine("installed to " + target);
            Console.WriteLine("files copied: " + copied);
            Console.WriteLine("start with Windows: " + (autostart.IsEnabled ? "on" : "off"));

            // Why said out loud: an install that silently left an older copy running is exactly the
            // confusion this check exists to prevent.
            if (copied > 0)
            {
                Console.WriteLine("note: quit the running tray app, or sign out and back in, so the new copy starts");
            }

            return 0;
        }

        private static int Uninstall()
        {
            var targetDirectory = InstallTargetDirectory();

            if (IsRunningFromInstall())
            {
                Console.WriteLine("run this from the published exe, not the installed copy, to remove it");
                return 1;
            }

            // Why first: a removed autostart entry with a lingering binary is harmless, but a
            // lingering binary that still starts on login is not.
            new Autostart().Disable();

            if (Directory.Exists(targetDirectory))
            {
                // Why the directory and not just the exe: the dependency assemblies live here too,
                // and leaving them behind would strand a broken half-install.
                Directory.Delete(targetDirectory, recursive: true);
            }

            Console.WriteLine("uninstalled");
            return 0;
        }

        private static int Status()
        {
            var autostart = new Autostart();
            var target = InstallTargetPath();
            var directory = InstallTargetDirectory();

            Console.WriteLine("start with Windows: " + (autostart.Value ?? "(off)"));
            Console.WriteLine("points at the installed copy: " + autostart.PointsAt(target));
            Console.WriteLine("installed copy: " + (File.Exists(target) ? target : "(missing)"));
            Console.WriteLine("files installed: " +
                              (Directory.Exists(directory) ? Directory.GetFiles(directory).Length : 0));
            Console.WriteLine("this exe: " + ExecutablePath());
            if (IsRunningAheadOfInstall())
            {
                Console.WriteLine("installed copy is older than this exe: run --install to refresh it");
            }

            return 0;
        }

        private static bool IsRunningAheadOfInstall() =>
            !IsRunningFromInstall() && IsInstalledCopyStale(ExecutablePath());

        private static bool SameDirectory(string a, string b) =>
            string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

        private static bool IsRunningFromInstall() => SameDirectory(
            Path.GetDirectoryName(ExecutablePath())!,
            InstallTargetDirectory());

        private static string ExecutablePath() =>
            Assembly.GetExecutingAssembly().Location.Length > 0
                ? Assembly.GetExecutingAssembly().Location
                : Process.GetCurrentProcess().MainModule!.FileName;
    }
}
