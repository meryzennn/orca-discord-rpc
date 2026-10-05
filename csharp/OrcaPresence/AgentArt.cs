using System.Collections.Generic;

namespace OrcaPresence
{
    public static class AgentArt
    {
        public const string BranchArtKey = "git-branch";

        /// <summary>Public stand-in for the branch slot when the uploaded asset is not in play.</summary>
        public const string BranchIconUrl =
            "https://www.google.com/s2/favicons?domain=git-scm.com&sz=128";

        /// <summary>Asset keys to upload to the Discord application. The source files share the name.</summary>
        private static readonly Dictionary<string, string> ArtKeys = new Dictionary<string, string>
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

        /// <summary>Agent type to the site whose favicon stands in when nothing is uploaded.</summary>
        private static readonly Dictionary<string, string> IconDomains = new Dictionary<string, string>
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

        /// <summary>The uploaded asset key for an agent, or null when it has none.</summary>
        public static string? ArtKey(string agentType) =>
            ArtKeys.TryGetValue(agentType, out var key) ? key : null;

        /// <summary>A public image URL for an agent, used when uploaded art is not in play.</summary>
        public static string? FaviconUrl(string agentType) =>
            IconDomains.TryGetValue(agentType, out var domain)
                ? "https://www.google.com/s2/favicons?domain=" + domain + "&sz=256"
                : null;
    }
}
