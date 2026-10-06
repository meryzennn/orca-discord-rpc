using System;

namespace OrcaPresence
{
    public enum AutostartCommand
    {
        None,
        Enable,
        Disable,
        Status
    }

    /// <summary>Where the autostart entry lives, so the rules can be tested without a registry.</summary>
    public interface IAutostartStore
    {
        string? Read();

        void Write(string value);

        void Delete();
    }

    /// <summary>The real store: the user's own Run key, which needs no administrator.</summary>
    public sealed class RegistryAutostartStore : IAutostartStore
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public const string RunValueName = "OrcaDiscordPresence";

        public static string KeyPath => @"HKEY_CURRENT_USER\" + RunKeyPath;

        public string? Read()
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKeyPath))
            {
                return key?.GetValue(RunValueName) as string;
            }
        }

        public void Write(string value)
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                key?.SetValue(RunValueName, value);
            }
        }

        public void Delete()
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true))
            {
                if (key != null && key.GetValue(RunValueName) != null)
                {
                    key.DeleteValue(RunValueName, throwOnMissingValue: false);
                }
            }
        }
    }

    /// <summary>
    /// The "start with Windows" switch. Kept separate from the install so it can be turned on and
    /// off on its own, from the CLI or the tray menu.
    /// </summary>
    public sealed class Autostart
    {
        private readonly IAutostartStore _store;

        public Autostart(IAutostartStore? store = null)
        {
            _store = store ?? new RegistryAutostartStore();
        }

        /// <summary>The raw entry, for a status report.</summary>
        public string? Value => _store.Read();

        public bool IsEnabled => !string.IsNullOrEmpty(_store.Read());

        /// <summary>Whether the entry points at this exact executable.</summary>
        public bool PointsAt(string executablePath)
        {
            var current = _store.Read();
            if (string.IsNullOrEmpty(current))
            {
                return false;
            }

            return string.Equals(current!.Trim('"'), executablePath, StringComparison.OrdinalIgnoreCase);
        }

        public void Enable(string executablePath)
        {
            // Why skipped when unchanged: rewriting on every menu build would be pointless churn.
            if (PointsAt(executablePath))
            {
                return;
            }

            // Why quoted: an unquoted path with a space would be split by the shell at login.
            _store.Write("\"" + executablePath + "\"");
        }

        public void Disable() => _store.Delete();

        public void Toggle(string executablePath)
        {
            if (PointsAt(executablePath))
            {
                Disable();
            }
            else
            {
                Enable(executablePath);
            }
        }

        /// <summary>
        /// Accepts `autostart [enable|disable|status]`, `--install`, `--uninstall`, `--status`, etc.
        /// </summary>
        public static AutostartCommand Parse(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                return AutostartCommand.None;
            }

            var word = args[0] == "autostart" && args.Length > 1 ? args[1] : args[0];

            switch (word)
            {
                case "enable":
                case "--enable":
                case "install":
                case "--install":
                    return AutostartCommand.Enable;

                case "disable":
                case "--disable":
                case "uninstall":
                case "--uninstall":
                    return AutostartCommand.Disable;

                case "status":
                case "--status":
                    return AutostartCommand.Status;

                default:
                    return AutostartCommand.None;
            }
        }

        /// <summary>Returns the full path to the currently running executable.</summary>
        public static string CurrentExecutablePath()
        {
            var main = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            if (!string.IsNullOrEmpty(main))
            {
                return main!;
            }
            return System.Reflection.Assembly.GetExecutingAssembly().Location;
        }
    }
}
