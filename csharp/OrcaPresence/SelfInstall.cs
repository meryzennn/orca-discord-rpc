using System;
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
            var target = InstallTargetPath();
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);

            // Why a copy: the exe the user downloaded may be in Downloads, which they will clean.
            if (!string.Equals(source, target, StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(source, target, overwrite: true);
            }

            Microsoft.Win32.Registry.SetValue(AutostartKeyPath, RunValueName, "\"" + target + "\"");
            Console.WriteLine("installed to " + target);
            Console.WriteLine("autostart entry: " + AutostartKeyPath + "\\" + RunValueName);
            return 0;
        }

        private static int Uninstall()
        {
            var target = InstallTargetPath();

            // Why deleted first: a removed autostart entry with a lingering binary is harmless, but
            // a lingering binary that still starts on login is not.
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true))
            {
                if (key != null && key.GetValue(RunValueName) != null)
                {
                    key.DeleteValue(RunValueName, throwOnMissingValue: false);
                }
            }

            if (IsRunningFromInstall() && File.Exists(target))
            {
                Console.WriteLine("run this from the published exe, not the installed copy, to remove it");
                return 1;
            }

            if (File.Exists(target))
            {
                File.Delete(target);
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
