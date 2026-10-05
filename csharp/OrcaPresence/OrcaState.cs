using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OrcaPresence
{
    /// <summary>Only the fields this tool reads from `orca worktree ps --json`.</summary>
    public sealed class OrcaAgent
    {
        [JsonPropertyName("state")] public string? State { get; set; }

        [JsonPropertyName("agentType")] public string? AgentType { get; set; }

        [JsonPropertyName("stateStartedAt")] public long? StateStartedAt { get; set; }
    }

    public sealed class OrcaWorktreeMeta
    {
        [JsonPropertyName("displayNameIsPinned")] public bool? DisplayNameIsPinned { get; set; }
    }

    public sealed class OrcaWorktree
    {
        [JsonPropertyName("worktreeId")] public string? WorktreeId { get; set; }

        [JsonPropertyName("displayName")] public string? DisplayName { get; set; }

        [JsonPropertyName("branch")] public string? Branch { get; set; }

        [JsonPropertyName("path")] public string? Path { get; set; }

        [JsonPropertyName("isActive")] public bool? IsActive { get; set; }

        [JsonPropertyName("meta")] public OrcaWorktreeMeta? Meta { get; set; }

        [JsonPropertyName("agents")] public OrcaAgent[] Agents { get; set; } = Array.Empty<OrcaAgent>();
    }

    public static class OrcaState
    {
        /// <summary>
        /// Why: hydrated rows carry a small synthetic stamp, and treating it as newest would hand
        /// the first line to a restored session over an agent the user actually has open.
        /// </summary>
        public const long MinAgentStateStartedAt = 1_000_000_000_000L;

        /// <summary>States that mean an agent is doing or awaiting work. `done` is not one.</summary>
        private static readonly HashSet<string> LiveStates =
            new HashSet<string>(StringComparer.Ordinal) { "working", "blocked", "waiting" };

        public static OrcaWorktree[] ParseWorktreePs(string stdout)
        {
            try
            {
                using var document = JsonDocument.Parse(stdout);
                var root = document.RootElement;

                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("ok", out var ok) ||
                    ok.ValueKind != JsonValueKind.True ||
                    !root.TryGetProperty("result", out var result) ||
                    result.ValueKind != JsonValueKind.Object ||
                    !result.TryGetProperty("worktrees", out var worktrees) ||
                    worktrees.ValueKind != JsonValueKind.Array)
                {
                    return Array.Empty<OrcaWorktree>();
                }

                var parsed = new List<OrcaWorktree>();
                foreach (var element in worktrees.EnumerateArray())
                {
                    if (element.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    var worktree = JsonSerializer.Deserialize<OrcaWorktree>(element.GetRawText());
                    if (worktree != null)
                    {
                        // Why assigned here: a missing `agents` must read as empty, never null.
                        worktree.Agents = worktree.Agents ?? Array.Empty<OrcaAgent>();
                        parsed.Add(worktree);
                    }
                }

                return parsed.ToArray();
            }
            catch (JsonException)
            {
                return Array.Empty<OrcaWorktree>();
            }
        }

        public static OrcaWorktree? SelectActiveWorktree(IEnumerable<OrcaWorktree>? worktrees) =>
            worktrees?.FirstOrDefault(w => w.IsActive == true);

        /// <summary>Agents doing or awaiting work right now; `done` means the agent is between turns.</summary>
        public static IReadOnlyList<OrcaAgent> LiveAgents(OrcaWorktree? worktree) =>
            AllAgents(worktree).Where(a => a.State != null && LiveStates.Contains(a.State)).ToList();

        /// <summary>
        /// Every agent whose pane is open, whether or not it is mid-turn. A row with no agent type
        /// is a plain terminal, not an agent.
        /// </summary>
        public static IReadOnlyList<OrcaAgent> OpenAgents(OrcaWorktree? worktree) => AllAgents(worktree);

        private static List<OrcaAgent> AllAgents(OrcaWorktree? worktree) =>
            (worktree?.Agents ?? Array.Empty<OrcaAgent>())
                .Where(a => a.State != null && !string.IsNullOrEmpty(a.AgentType))
                .ToList();

        public static bool HasActiveAgent(OrcaWorktree? worktree) => LiveAgents(worktree).Count > 0;

        public static int OpenAgentCount(OrcaWorktree? worktree) => OpenAgents(worktree).Count;

        /// <summary>
        /// The agent the profile should name: the most recently active one, which Orca orders by
        /// `stateStartedAt`. A live agent wins over a newer idle one, so an observer sees the
        /// busier session.
        /// </summary>
        public static OrcaAgent? FeaturedAgent(OrcaWorktree? worktree)
        {
            var live = LiveAgents(worktree);
            var candidates = live.Count > 0 ? live : OpenAgents(worktree);
            if (candidates.Count == 0)
            {
                return null;
            }

            var best = candidates[0];
            var bestAt = StateStartedAtOf(best);
            for (var i = 1; i < candidates.Count; i++)
            {
                var startedAt = StateStartedAtOf(candidates[i]);
                if (startedAt > bestAt)
                {
                    best = candidates[i];
                    bestAt = startedAt;
                }
            }

            return best;
        }

        /// <summary>
        /// The folder the workspace lives in. Orca's display name defaults to the branch on a git
        /// worktree, so the path is the folder. A workspace the user renamed keeps its label.
        /// </summary>
        public static string? ProjectNameFor(OrcaWorktree? worktree)
        {
            var label = DisplayNameFor(worktree);
            if (label != null && worktree?.Meta?.DisplayNameIsPinned == true)
            {
                return label;
            }

            return FolderNameFromPath(worktree?.Path) ?? label;
        }

        /// <summary>The branch with the `refs/heads/` prefix stripped, for the icon tooltip.</summary>
        public static string? BranchNameFor(OrcaWorktree? worktree)
        {
            var branch = worktree?.Branch;
            if (string.IsNullOrEmpty(branch))
            {
                return null;
            }

            return branch!.StartsWith("refs/heads/", StringComparison.Ordinal)
                ? branch.Substring("refs/heads/".Length)
                : branch;
        }

        private static string? DisplayNameFor(OrcaWorktree? worktree) =>
            string.IsNullOrEmpty(worktree?.DisplayName) ? null : worktree!.DisplayName;

        private static string? FolderNameFromPath(string? path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }

            var segments = path!.Split('/', '\\').Where(s => s.Length > 0).ToArray();
            return segments.Length > 0 ? segments[segments.Length - 1] : null;
        }

        private static long StateStartedAtOf(OrcaAgent agent)
        {
            var value = agent.StateStartedAt;
            if (value == null)
            {
                return long.MinValue;
            }

            // Why a floor: a hydrated row's synthetic stamp must sort oldest, never newest.
            return value.Value >= MinAgentStateStartedAt ? value.Value : long.MinValue;
        }
    }
}
