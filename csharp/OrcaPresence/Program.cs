using System;
using System.Threading;
using System.Windows.Forms;

namespace OrcaPresence
{
    internal static class Program
    {
        /// <summary>
        /// Why a global mutex: two copies would run two presences fighting over the profile, which
        /// shows up as the activity flickering between two states.
        /// </summary>
        private const string SingleInstanceName = "Global\\OrcaDiscordPresence";

        [STAThread]
        private static int Main(string[] args)
        {
            // Why: a tray app has no console, so anything that needs to be seen goes to a file.
            if (args.Length > 0 && SelfInstall.IsInstallCommand(args))
            {
                return SelfInstall.Run(args);
            }

            using (var mutex = new Mutex(initiallyOwned: true, name: SingleInstanceName, createdNew: out var isFirst))
            {
                if (!isFirst)
                {
                    // Why: the newest launch exits rather than running a second presence.
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var config = AppConfig.Load();
                using (var host = new TrayHost(config))
                {
                    host.Start();
                    // Why an ApplicationContext and not a Form: the tray icon is the only UI, so no
                    // window exists and the app can never take focus.
                    Application.Run(new ApplicationContext());
                }

                return 0;
            }
        }
    }
}
