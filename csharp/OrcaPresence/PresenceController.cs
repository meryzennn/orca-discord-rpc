using System;
using System.Threading.Tasks;

namespace OrcaPresence
{
    public sealed class PresenceState
    {
        public string? ProjectName { get; set; }

        /// <summary>The agent shown on line 1: the one that most recently entered its state.</summary>
        public string? AgentType { get; set; }

        public int OpenAgentCount { get; set; }

        /// <summary>False when the featured agent is between turns.</summary>
        public bool AgentActive { get; set; }

        /// <summary>Shown as the branch icon's tooltip.</summary>
        public string? BranchName { get; set; }

        public string? RepoUrl { get; set; }
    }

    /// <summary>
    /// Turns polling into Discord updates: an unchanged reading costs nothing, and the elapsed
    /// timer persists across workspace and agent switches during an active session.
    /// </summary>
    public sealed class PresenceController
    {
        private readonly Func<Task<PresenceState?>> _readState;
        private readonly Func<PresenceActivity, Task<bool>> _apply;
        private readonly Func<Task<bool>> _clear;
        private readonly Func<int>? _connectionEpoch;
        private readonly Func<DateTime> _now;
        private readonly Func<bool> _useUploadedArt;
        private readonly Func<bool>? _incognito;

        private string? _lastKey;
        private DateTime? _sessionStartedAt;
        private int _lastEpoch;

        public PresenceController(
            Func<Task<PresenceState?>> readState,
            Func<PresenceActivity, Task<bool>> apply,
            Func<Task<bool>> clear,
            Func<int>? connectionEpoch,
            Func<DateTime> now,
            Func<bool> useUploadedArt,
            Func<bool>? incognito = null)
        {
            _readState = readState;
            _apply = apply;
            _clear = clear;
            _connectionEpoch = connectionEpoch;
            _now = now;
            _useUploadedArt = useUploadedArt;
            _incognito = incognito;
            _lastEpoch = connectionEpoch?.Invoke() ?? 0;
        }

        /// <summary>Forgets what was last sent, so the next poll pushes again.</summary>
        public void Reset()
        {
            _lastKey = null;
            _sessionStartedAt = null;
        }

        public async Task PollAsync()
        {
            // Why: after a reconnect the activity Discord holds is gone, so the same state is new.
            var epoch = _connectionEpoch?.Invoke() ?? _lastEpoch;
            if (epoch != _lastEpoch)
            {
                _lastEpoch = epoch;
                _lastKey = null;
            }

            PresenceState? state;
            try
            {
                state = await _readState();
            }
            catch
            {
                // Why swallowed: the Orca CLI may be missing or mid-update; the next tick retries.
                return;
            }

            if (state == null)
            {
                if (_lastKey == NoneKey)
                {
                    return;
                }

                bool cleared;
                try
                {
                    cleared = await _clear();
                }
                catch
                {
                    cleared = false;
                }

                if (cleared)
                {
                    _lastKey = NoneKey;
                    _sessionStartedAt = null;
                }

                return;
            }

            var isIncognito = _incognito?.Invoke() ?? false;
            var key = string.Join("|", new[]
            {
                state.ProjectName ?? "",
                state.AgentType ?? "",
                state.OpenAgentCount.ToString(),
                state.AgentActive ? "1" : "0",
                state.BranchName ?? "",
                state.RepoUrl ?? "",
                isIncognito ? "1" : "0"
            });

            if (key == _lastKey)
            {
                return;
            }

            var startedAt = _sessionStartedAt ?? _now();

            var activity = Presence.BuildActivity(new PresenceInput
            {
                ProjectName = state.ProjectName,
                AgentType = state.AgentType,
                OpenAgentCount = state.OpenAgentCount,
                AgentActive = state.AgentActive,
                BranchName = state.BranchName,
                RepoUrl = state.RepoUrl,
                Incognito = isIncognito,
                StartedAt = startedAt,
                UseUploadedArt = _useUploadedArt()
            });

            bool applied;
            try
            {
                applied = await _apply(activity);
            }
            catch
            {
                applied = false;
            }

            if (applied)
            {
                _lastKey = key;
                _sessionStartedAt = startedAt;
            }
        }

        private const string NoneKey = "__none__";
    }
}
