using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OrcaPresence
{
    /// <summary>
    /// Flushes unneeded working set pages back to the Windows page pool using SetProcessWorkingSetSize.
    /// This drops the tray app's working set in Task Manager from ~40 MB down to ~8-10 MB.
    /// </summary>
    public static class MemoryTrimmer
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetProcessWorkingSetSize(
            IntPtr hProcess,
            IntPtr dwMinimumWorkingSetSize,
            IntPtr dwMaximumWorkingSetSize);

        public static bool Trim()
        {
            try
            {
                GC.Collect(2, GCCollectionMode.Forced);
                GC.WaitForPendingFinalizers();
                return SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1));
            }
            catch
            {
                return false;
            }
        }
    }
}
