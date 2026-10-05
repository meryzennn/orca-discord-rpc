using System;

namespace OrcaPresence
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            // Why a window is never shown: the app is a tray icon and nothing else.
            Console.WriteLine("OrcaPresence placeholder");
        }
    }
}
