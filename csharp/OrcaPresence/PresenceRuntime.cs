using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace OrcaPresence
{
    public sealed class RuntimeStatus
    {
        public bool DiscordConnected { get; set; }

        public bool OrcaRunning { get; set; }

        public bool Paused { get; set; }

        public PresenceActivity? LastActivity { get; set; }

        public DateTime? LastPushAt { get; set; }

        public string? LastError { get; set; }
    }

    /// <summary>The pieces a host can substitute, so the runtime is testable without Discord or Orca.</summary>
    public sealed class RuntimeDeps
    {
        public Func<Task<bool>> IsOrcaRunning { get; set; } = () => Task.FromResult(false);

        public Func<Task<PresenceState?>> ReadState { get; set; } = () => Task.FromResult<PresenceState?>(null);

        public Func<PresenceActivity, Task<bool>> Apply { get; set; } = _ => Task.FromResult(false);

        public Func<Task<bool>> Clear { get; set; } = () => Task.FromResult(false);

        public Func<int>? ConnectionGeneration { get; set; }

        /// <summary>Returns a cancel function. Injected so tests need no real timer.</summary>
        public Func<Func<Task>, Action> Schedule { get; set; } = _ => () => { };
    }

    /// <summary>
    /// Owns polling, the Orca gate, the Discord transport and the status snapshot, so a host only
    /// has to present it.
    /// </summary>
    public sealed class PresenceRuntime : IDisposable
    {
        private readonly RuntimeDeps _deps;
        private readonly int _pollMs;
        private readonly Action<string> _log;
        private readonly DiscordPresence? _discord;
        private readonly Func<bool> _useUploadedArt;

        private readonly object _gate = new object();
        private Action? _cancel;
        private bool _started;
        private bool _paused;
        private bool _orcaRunning;
        private PresenceActivity? _lastActivity;
        private DateTime? _lastPushAt;
        private string? _lastError;

        public PresenceRuntime(
            string clientId,
            int pollMs,
            bool useUploadedArt,
            Action<string> log,
            RuntimeDeps? deps = null)
        {
            _pollMs = pollMs;
            _log = log;
            _useUploadedArt = () => useUploadedArt;

            if (deps != null)
            {
                _deps = deps;
            }
            else
            {
                var discord = new DiscordPresence(clientId);
                _discord = discord;
                _deps = new RuntimeDeps
                {
                    IsOrcaRunning = () => Task.FromResult(OrcaProcess.IsOrcaRunning()),
                    ReadState = () => Task.FromResult(OrcaReader.ReadPresenceState()),
                    Apply = activity => Task.FromResult(discord.Apply(activity)),
                    Clear = () => Task.FromResult(discord.Clear()),
                    ConnectionGeneration = () => discord.ConnectionGeneration,
                    Schedule = tick =>
                    {
                        var timer = new Timer(_ => tick(), null, pollMs, pollMs);
                        return () => timer.Dispose();
                    }
                };
            }
        }

        public event Action<RuntimeStatus>? StatusChanged;

        public RuntimeStatus Status
        {
            get
            {
                lock (_gate)
                {
                    return new RuntimeStatus
                    {
                        DiscordConnected = _discord?.IsConnected ?? _lastActivity != null,
                        OrcaRunning = _orcaRunning,
                        Paused = _paused,
                        LastActivity = _lastActivity,
                        LastPushAt = _lastPushAt,
                        LastError = _lastError
                    };
                }
            }
        }

        public async Task StartAsync()
        {
            var resuming = _paused || !_started;
            if (_paused)
            {
                _log("resuming; the cleared activity will be pushed again");
            }

            _started = true;
            _paused = false;

            // Why reset on a resume: whatever Discord was showing was cleared by pause/stop, so the
            // unchanged state has to be pushed again even though the dedupe key would match.
            if (resuming)
            {
                _controller?.Reset();
            }

            _cancel?.Invoke();
            _cancel = _deps.Schedule(TickAsync);
            await TickAsync();
        }

        /// <summary>Stops polling and clears the activity, but keeps the transport for a later start.</summary>
        public async Task PauseAsync()
        {
            _paused = true;
            _cancel?.Invoke();
            _cancel = null;
            try
            {
                await _deps.Clear();
                _log("paused; activity cleared");
            }
            catch
            {
                // Why swallowed: a clear failure must not break the tray.
            }

            Notify();
        }

        public async Task StopAsync()
        {
            _started = false;
            _paused = false;
            _cancel?.Invoke();
            _cancel = null;
            _discord?.Dispose();
            await Task.CompletedTask;
            Notify();
        }

        public void Dispose()
        {
            _cancel?.Invoke();
            _cancel = null;
            _discord?.Dispose();
        }

        private PresenceController? _controller;

        private PresenceController Controller
        {
            get
            {
                if (_controller == null)
                {
                    _controller = new PresenceController(
                        readState: ReadGatedStateAsync,
                        apply: async activity =>
                        {
                            var ok = await _deps.Apply(activity);
                            lock (_gate)
                            {
                                if (ok)
                                {
                                    _lastActivity = activity;
                                    _lastPushAt = DateTime.UtcNow;
                                    _lastError = null;
                                    // Why the art: this line is the only record of what Discord was told.
                                    _log("pushed: " + activity.Details + " | " + activity.State);
                                }
                                else
                                {
                                    _lastError = "Discord rejected or could not receive the activity";
                                    _log("push failed: " + activity.Details);
                                }
                            }

                            return ok;
                        },
                        clear: _deps.Clear,
                        connectionEpoch: _deps.ConnectionGeneration,
                        now: () => DateTime.UtcNow,
                        useUploadedArt: _useUploadedArt);
                }

                return _controller;
            }
        }

        private async Task<PresenceState?> ReadGatedStateAsync()
        {
            var running = await _deps.IsOrcaRunning();
            if (running != _orcaRunning)
            {
                _orcaRunning = running;
                _log(running
                    ? "Orca detected; reporting presence"
                    : "Orca closed; clearing presence");
            }

            // Why null: with Orca closed the controller clears rather than reporting a stale state.
            return running ? await _deps.ReadState() : null;
        }

        private async Task TickAsync()
        {
            if (!_started || _paused)
            {
                return;
            }

            try
            {
                await Controller.PollAsync();
            }
            catch (Exception error)
            {
                // Why only on throw: a failed push is recorded by the apply wrapper, and clearing
                // here would erase it before anyone could read the status.
                _lastError = error.Message;
            }

            Notify();
        }

        private void Notify()
        {
            var status = Status;
            var handlers = StatusChanged;
            if (handlers != null)
            {
                // Why invoked per subscriber: one throwing menu rebuild must not stop the others.
                foreach (Action<RuntimeStatus> handler in handlers.GetInvocationList())
                {
                    try
                    {
                        handler(status);
                    }
                    catch
                    {
                        // ignore
                    }
                }
            }
        }
    }
}
