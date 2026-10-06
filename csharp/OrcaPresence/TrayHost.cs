using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace OrcaPresence
{
    /// <summary>
    /// The tray icon and its menu. No window is ever created, so the app cannot take focus.
    /// </summary>
    public sealed class TrayHost : IDisposable
    {
        private readonly AppConfig _config;
        private readonly PresenceRuntime _runtime;
        private readonly NotifyIcon _icon;
        private bool _disposed;

        public TrayHost(AppConfig config)
        {
            _config = config;
            _runtime = new PresenceRuntime(
                clientId: config.ClientId,
                pollMs: config.PollMs,
                useUploadedArt: config.UseUploadedArt,
                log: Log);

            _icon = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = TrayStatus.AppDisplayName,
                Visible = true
            };
            _runtime.StatusChanged += status => Apply(status);
        }

        public void Start()
        {
            // Why not awaited: Application.Run below takes over the message loop, and the runtime
            // raises StatusChanged as it settles.
            var ignored = _runtime.StartAsync();
            Apply(_runtime.Status);
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _icon.Visible = false;
            _icon.Dispose();
            _runtime.Dispose();
        }

        /// <summary>
        /// Why a log file and not the console: a tray app has no console, so a failure would
        /// otherwise be invisible.
        /// </summary>
        private static void Log(string line)
        {
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "orca-discord-rpc",
                    "tray.log");
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 256 * 1024)
                {
                    File.WriteAllText(path, string.Empty);
                }

                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
            }
            catch
            {
                // Why tolerated: logging must never be the reason the tray dies.
            }
        }

        private static Icon LoadIcon()
        {
            try
            {
                // Why embedded: the shipped exe must carry its own icon with no loose files.
                using (var stream = Assembly.GetExecutingAssembly()
                           .GetManifestResourceStream("OrcaPresence.app.ico"))
                {
                    if (stream != null)
                    {
                        return new Icon(stream);
                    }
                }
            }
            catch
            {
                // Why the fallback: a missing icon must not stop the app from starting.
            }

            return SystemIcons.Application;
        }

        private void Apply(RuntimeStatus status)
        {
            if (_disposed)
            {
                return;
            }

            var described = TrayStatus.Describe(status);
            // Why short: NotifyIcon.Text is capped at 63 characters by the shell.
            var tooltip = described.Tooltip.Length > 63 ? described.Tooltip.Substring(0, 60) + "..." : described.Tooltip;
            _icon.Text = tooltip;
            _icon.ContextMenuStrip = BuildMenu(status, described);
        }

        private ContextMenuStrip BuildMenu(RuntimeStatus status, TrayStatusInfo described)
        {
            var menu = new ContextMenuStrip();

            var header = new ToolStripMenuItem(TrayStatus.AppDisplayName) { Enabled = false };
            menu.Items.Add(header);

            var state = new ToolStripMenuItem(described.Headline) { Enabled = false };
            menu.Items.Add(state);

            menu.Items.Add(new ToolStripSeparator());

            var toggle = new ToolStripMenuItem(status.Paused ? "Enable presence" : "Disable presence");
            toggle.Click += (_, __) =>
            {
                var ignored = status.Paused ? _runtime.StartAsync() : _runtime.PauseAsync();
            };
            menu.Items.Add(toggle);

            // Why only while Discord is missing: the row is what the user needs in that state.
            if (!status.DiscordConnected)
            {
                var reconnect = new ToolStripMenuItem("Reconnect to Discord");
                reconnect.Click += (_, __) =>
                {
                    var ignored = _runtime.StopAsync().ContinueWith(_ => _runtime.StartAsync());
                };
                menu.Items.Add(reconnect);
            }

            menu.Items.Add(new ToolStripMenuItem("Application id: " + _config.ClientId) { Enabled = false });

            // Why a checkable row: turning the login start on and off is the one setting a user
            // changes, and it should not need the command line.
            var autostart = new Autostart();
            var currentExe = Autostart.CurrentExecutablePath();
            var startWithWindows = new ToolStripMenuItem("Start with Windows")
            {
                Checked = autostart.PointsAt(currentExe),
                CheckOnClick = false
            };
            startWithWindows.Click += (_, __) =>
            {
                autostart.Toggle(currentExe);
                // Why rebuilt rather than toggled in place: the menu is rebuilt from state anyway.
                Apply(_runtime.Status);
            };
            menu.Items.Add(startWithWindows);

            menu.Items.Add(new ToolStripSeparator());

            var quit = new ToolStripMenuItem("Quit");
            quit.Click += (_, __) =>
            {
                var ignored = _runtime.StopAsync().ContinueWith(_ => Application.Exit());
            };
            menu.Items.Add(quit);

            return menu;
        }
    }
}
