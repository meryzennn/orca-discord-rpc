using System;
using System.Collections.Generic;

namespace OrcaPresence
{
    /// <summary>
    /// Artwork mappings for branch and agent icons.
    /// Supports uploaded Discord application assets and public fallback favicons.
    /// </summary>
    public static class AgentArt
    {
        /// <summary>Asset key for the branch icon, when artwork is registered on the application.</summary>
        public const string BranchArtKey = "git-branch";

        /// <summary>Public stand-in for the branch slot when nothing is uploaded.</summary>
        public const string BranchIconUrl =
            "https://www.google.com/s2/favicons?domain=git-scm.com&sz=128";

        private static readonly Dictionary<string, string> AgentArtKeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["claude"] = "claude",
            ["claude-agent-teams"] = "claude",
            ["codex"] = "codex",
            ["opencode"] = "opencode",
            ["opencode2"] = "opencode",
            ["command-code"] = "commandcode",
            ["dsh"] = "deepsek-harnnes",
            ["grok"] = "grock",
            ["hermes"] = "hermes",
            ["antigravity"] = "agy",
            ["agy"] = "agy"
        };

        private static readonly Dictionary<string, string> AgentIconDomains = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["claude"] = "claude.ai",
            ["claude-agent-teams"] = "claude.ai",
            ["codex"] = "openai.com",
            ["opencode"] = "opencode.ai",
            ["opencode2"] = "opencode.ai",
            ["command-code"] = "commandcode.ai",
            ["dsh"] = "deepseek.com",
            ["grok"] = "x.ai",
            ["hermes"] = "hermes.nousresearch.com",
            ["antigravity"] = "antigravity.google",
            ["agy"] = "antigravity.google",
            ["cursor"] = "cursor.com",
            ["gemini"] = "gemini.google.com",
            ["copilot"] = "github.com",
            ["amp"] = "ampcode.com",
            ["aider"] = "aider.chat",
            ["goose"] = "block.github.io",
            ["devin"] = "devin.ai",
            ["kimi"] = "kimi.moonshot.cn"
        };

        public static string? GetAgentArtKey(string agentType)
        {
            return AgentArtKeys.TryGetValue(agentType, out var key) ? key : null;
        }

        public static string? GetAgentIconUrl(string agentType)
        {
            if (AgentIconDomains.TryGetValue(agentType, out var domain))
            {
                return "https://www.google.com/s2/favicons?domain=" + domain + "&sz=128";
            }
            return null;
        }
    }
}
