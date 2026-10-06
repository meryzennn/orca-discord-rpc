namespace OrcaPresence
{
    public enum TrayTone
    {
        Ok,
        Idle,
        Waiting,
        Error
    }

    public sealed class TrayStatusInfo
    {
        public TrayTone Tone { get; set; }

        public string Headline { get; set; } = "";

        public string Detail { get; set; } = "";

        public string Tooltip { get; set; } = "";
    }

    public static class TrayStatus
    {
        public const string AppDisplayName = "Orca Discord Presence";

        /// <summary>
        /// Maps runtime state to the one line the menu shows, most actionable problem first:
        /// error, then paused, then Orca closed, then Discord missing, then the activity.
        /// </summary>
        public static TrayStatusInfo Describe(RuntimeStatus status)
        {
            var detail = status.LastActivity?.State ?? "";

            if (!string.IsNullOrEmpty(status.LastError))
            {
                return Finish(TrayTone.Error, "Problem", status.LastError!);
            }

            if (status.Paused)
            {
                return Finish(TrayTone.Idle, "Presence paused", "Enable it from this menu");
            }

            if (!status.OrcaRunning)
            {
                return Finish(TrayTone.Idle, "Orca is not running", "Waiting for Orca to open");
            }

            if (!status.DiscordConnected)
            {
                return Finish(TrayTone.Waiting, "Discord not detected", "Is the Discord desktop client running?");
            }

            if (status.LastActivity != null)
            {
                return Finish(TrayTone.Ok, status.LastActivity.Details, detail);
            }

            return Finish(TrayTone.Idle, "No agent detected", detail);
        }

        private static TrayStatusInfo Finish(TrayTone tone, string headline, string detail)
        {
            var tooltip = detail.Length > 0
                ? AppDisplayName + " — " + headline + " (" + detail + ")"
                : AppDisplayName + " — " + headline;
            return new TrayStatusInfo { Tone = tone, Headline = headline, Detail = detail, Tooltip = tooltip };
        }
    }
}
