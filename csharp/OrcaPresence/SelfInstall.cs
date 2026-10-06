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
    /// Installs the app without an installer: the exe copies itself somewhere durable and writes
    /// its own autostart entry under the user's own registry key, so no administrator is needed.
    /// </summary>
    public static class SelfInstall
    {
        public const string RunValueName = "OrcaDiscordPresence";

        private const string RunKeyPath =
            @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static string AutostartKeyPath => @"HKEY_CURRENT_USER\" + RunKeyPath;

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
                // Why skipped: a symbol file is not needed to run, and a config is per-machine.
                if (name.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                files.Add(name);
            }

            files.Sort(StringComparer.OrdinalIgnoreCase);
            return files;
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
            if (!string.Equals(sourceDirectory.TrimEnd('\\'), targetDirectory.TrimEnd('\\'),
                    StringComparison.OrdinalIgnoreCase))
            {
                foreach (var name in FilesToCopy(sourceDirectory))
                {
                    File.Copy(Path.Combine(sourceDirectory, name), Path.Combine(targetDirectory, name), overwrite: true);
                    copied++;
                }
            }

            Microsoft.Win32.Registry.SetValue(AutostartKeyPath, RunValueName, "\"" + target + "\"");
            Console.WriteLine("installed to " + target);
            Console.WriteLine("files copied: " + copied);
            Console.WriteLine("autostart entry: " + AutostartKeyPath + "\\" + RunValueName);
            return 0;
        }

        private static int Uninstall()
        {
            var targetDirectory = InstallTargetDirectory();

            // Why deleted first: a removed autostart entry with a lingering binary is harmless, but
            // a lingering binary that still starts on login is not.
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true))
            {
                if (key != null && key.GetValue(RunValueName) != null)
                {
                    key.DeleteValue(RunValueName, throwOnMissingValue: false);
                }
            }

            if (IsRunningFromInstall())
            {
                Console.WriteLine("run this from the published exe, not the installed copy, to remove it");
                return 1;
            }

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
            var entry = Microsoft.Win32.Registry.GetValue(AutostartKeyPath, RunValueName, null) as string;
            var target = InstallTargetPath();
            Console.WriteLine("autostart: " + (entry ?? "(not set)"));
            Console.WriteLine("installed copy: " + (File.Exists(target) ? target : "(missing)"));
            var directory = InstallTargetDirectory();
            Console.WriteLine("files installed: " + (Directory.Exists(directory) ? Directory.GetFiles(directory).Length : 0));
            Console.WriteLine("this exe: " + ExecutablePath());
            return 0;
        }

        private static bool IsRunningFromInstall() =>
            string.Equals(ExecutablePath(), InstallTargetPath(), StringComparison.OrdinalIgnoreCase);

        private static string ExecutablePath() =>
            Assembly.GetExecutingAssembly().Location.Length > 0
                ? Assembly.GetExecutingAssembly().Location
                : Process.GetCurrentProcess().MainModule!.FileName;
    }
}
