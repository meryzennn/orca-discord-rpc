using System;
using System.Collections.Generic;
using System.Text;

namespace OrcaPresence
{
    public sealed class PresenceInput
    {
        public string? ProjectName { get; set; }

        /// <summary>The agent shown on line 1: the one that most recently entered its state.</summary>
        public string? AgentType { get; set; }

        public int OpenAgentCount { get; set; }

        /// <summary>False when the featured agent is between turns.</summary>
        public bool AgentActive { get; set; } = true;

        /// <summary>Shown as the branch icon's tooltip; line 2 carries the status instead.</summary>
        public string? BranchName { get; set; }

        public string? RepoUrl { get; set; }

        public bool Incognito { get; set; }

        public DateTime StartedAt { get; set; }

        /// <summary>
        /// True when the artwork has been uploaded to the Discord application. Discord will not
        /// fetch a loopback URL, so uploaded assets are the only way to use bundled PNGs.
        /// </summary>
        public bool UseUploadedArt { get; set; }
    }

    public sealed class ActivityButton
    {
        public string Label { get; set; } = "";
        public string Url { get; set; } = "";
    }

    public sealed class PresenceActivity
    {
        public string Details { get; set; } = "";

        public string State { get; set; } = "";

        public DateTime StartTimestamp { get; set; }

        public string? LargeImageKey { get; set; }

        public string? LargeImageText { get; set; }

        public string? SmallImageKey { get; set; }

        public string? SmallImageUrl { get; set; }

        public string? SmallImageText { get; set; }

        public List<ActivityButton>? Buttons { get; set; }
    }

    public static class Presence
    {
        public const string PresenceAssetKey = "orca";

        /// <summary>Discord truncates activity fields at 128 characters.</summary>
        public const int FieldLimit = 128;

        public const int ProjectLimit = 100;

        /// <summary>
        /// Discord rejects any activity field shorter than this, and one bad field fails the
        /// whole update.
        /// </summary>
        public const int FieldMin = 2;

        /// <summary>Brand spellings a naive title-case would mangle.</summary>
        private static readonly Dictionary<string, string> KnownAgentLabels = new Dictionary<string, string>
        {
            ["claude-agent-teams"] = "Claude",
            ["opencode"] = "OpenCode",
            ["opencode2"] = "OpenCode",
            ["qwen-code"] = "Qwen Code"
        };

        public static string AgentDisplayName(string agentType)
        {
            if (KnownAgentLabels.TryGetValue(agentType, out var known))
            {
                return known;
            }

            var parts = new List<string>();
            foreach (var part in agentType.Split('-', '_', ' '))
            {
                if (part.Length > 0)
                {
                    parts.Add(char.ToUpperInvariant(part[0]) + part.Substring(1));
                }
            }

            return string.Join(" ", parts);
        }

        public static PresenceActivity BuildActivity(PresenceInput input)
        {
            var isIncognito = input.Incognito;
            var rawFolder = isIncognito ? "Private Project" : input.ProjectName;
            var normalizedFolder = !string.IsNullOrWhiteSpace(rawFolder)
                ? NormalizeName(rawFolder!)
                : "";
            var folder = Field(normalizedFolder);
            var project = folder.Length > 0
                ? (folder.StartsWith("Folder:", StringComparison.OrdinalIgnoreCase)
                    ? folder
                    : Truncate("Folder: " + folder, ProjectLimit))
                : "";
            var count = Math.Max(0, input.OpenAgentCount);
            var branchText = (!isIncognito && input.BranchName != null)
                ? Truncate(NormalizeName(input.BranchName), FieldLimit)
                : "Branch";
            var uploaded = input.UseUploadedArt;

            var activity = new PresenceActivity
            {
                StartTimestamp = input.StartedAt,
                LargeImageText = "Orca",
                // The branch name is the icon's tooltip, since line 2 carries the agent status.
                SmallImageText = !isIncognito ? (branchText.Length >= FieldMin ? branchText : "Branch") : null,
                SmallImageKey = (!isIncognito && uploaded) ? AgentArt.BranchArtKey : null,
                SmallImageUrl = (!isIncognito && !uploaded) ? AgentArt.BranchIconUrl : null,
                LargeImageKey = uploaded ? PresenceAssetKey : null
            };

            if (!isIncognito && !string.IsNullOrEmpty(input.RepoUrl))
            {
                activity.Buttons = new List<ActivityButton>
                {
                    new ActivityButton { Label = "View Repository", Url = input.RepoUrl! }
                };
            }

            if (input.AgentType == null)
            {
                var state = ComposeStateLine(project, count);
                activity.Details = "Using Orca";
                activity.State = state.Length >= FieldMin ? state : "Orca";
                return activity;
            }

            var agent = AgentDisplayName(input.AgentType);
            activity.Details = agent.Length >= FieldMin
                ? Field("Agent: " + WithOtherAgents(agent, input.OpenAgentCount))
                : "";
            // Why the status and not a count: "+N" on line 1 already says how many are open.
            activity.State = ComposeAgentStateLine(project, input.AgentActive);
            return activity;
        }

        private static string Field(string value) => value.Length >= FieldMin ? value : "";

        /// <summary>Why: a name can carry newlines and runs of spaces, which Discord renders broken.</summary>
        private static string NormalizeName(string value) => string.Join(" ", value.Split((char[]?)null,
            StringSplitOptions.RemoveEmptyEntries));

        private static string Truncate(string value, int limit) =>
            value.Length <= limit ? value : value.Substring(0, limit);

        /// <summary>
        /// Names the featured agent and, when more are open, how many others there are: "Codex +1".
        /// Why on line 1: another open agent is the most useful thing an observer can be told,
        /// and the field limit leaves no room for it beside the project.
        /// </summary>
        private static string WithOtherAgents(string agent, int openAgentCount)
        {
            var others = Math.Max(0, openAgentCount) - 1;
            return others > 0 ? agent + " +" + others : agent;
        }

        /// <summary>Line 2 for an agent row: the folder, then whether the agent is mid-turn.</summary>
        private static string ComposeAgentStateLine(string project, bool active)
        {
            var status = active ? "Working" : "Idle";
            if (project.Length == 0)
            {
                return status;
            }

            var suffix = " · " + status;
            var room = Math.Max(0, FieldLimit - suffix.Length);
            return project.Length <= room ? project + suffix : project.Substring(0, room) + suffix;
        }

        /// <summary>Line 2 when no agent is known: the folder and the open-agent count.</summary>
        private static string ComposeStateLine(string project, int count)
        {
            var suffix = count > 1 ? " · " + count + " agents" : "";
            if (project.Length == 0)
            {
                // Why "agents" and not the count alone: a lone digit is under the field minimum.
                return count > 1 ? count + " agents" : "";
            }

            var room = Math.Max(0, FieldLimit - suffix.Length);
            return project.Length <= room ? project + suffix : project.Substring(0, room) + suffix;
        }
    }
}
