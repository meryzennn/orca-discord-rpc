using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OrcaPresence
{
    /// <summary>
    /// The model an agent is running. Orca does not report it, so this reads the agent's own
    /// session log: Claude Code under ~/.claude/projects, Codex under ~/.codex/sessions.
    /// </summary>
    public static class AgentModel
    {
        /// <summary>Why only the tail: a session log grows to megabytes and the newest turn is at the end.</summary>
        private const int TailBytes = 64 * 1024;

        /// <summary>Why so small: Codex writes the folder near the start of its first line.</summary>
        private const int HeadBytes = 16 * 1024;

        /// <summary>Why capped: Codex keeps every session for months, and only a recent one can be live.</summary>
        private const int CodexSessionsScanned = 50;

        /// <summary>
        /// Matches only a real JSON key. A model name quoted inside a message is escaped
        /// (\"model\"), so it never matches.
        /// </summary>
        private static readonly Regex ModelField = new Regex("\"model\":\"([^\"]+)\"", RegexOptions.Compiled);

        private static readonly Regex CwdField = new Regex("\"cwd\":(\"(?:[^\"\\\\]|\\\\.)*\")", RegexOptions.Compiled);

        public static string? Find(string? agentType, string? worktreePath) =>
            Find(agentType, worktreePath, Environment.GetEnvironmentVariable,
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

        public static string? Find(string? agentType, string? worktreePath, Func<string, string?> env, string home)
        {
            if (string.IsNullOrEmpty(agentType) || string.IsNullOrEmpty(worktreePath))
            {
                return null;
            }

            try
            {
                string? log;
                switch (agentType)
                {
                    case "claude":
                    case "claude-agent-teams":
                        log = NewestClaudeSession(NonEmpty(env("CLAUDE_CONFIG_DIR")) ?? Path.Combine(home, ".claude"), worktreePath!);
                        break;
                    case "codex":
                        log = NewestCodexSession(NonEmpty(env("CODEX_HOME")) ?? Path.Combine(home, ".codex"), worktreePath!);
                        break;
                    default:
                        return null;
                }

                var raw = log == null ? null : LastModelIn(ReadTail(log));
                return raw == null ? null : PrettyName(raw);
            }
            catch
            {
                // Why swallowed: an unreadable log must cost only the model name, never the presence.
                return null;
            }
        }

        /// <summary>Claude Code names a project folder after its path, with every other character a dash.</summary>
        public static string ClaudeProjectSlug(string path) => Regex.Replace(path, "[^A-Za-z0-9]", "-");

        public static string? LastModelIn(string text)
        {
            string? last = null;
            foreach (Match match in ModelField.Matches(text))
            {
                var value = match.Groups[1].Value;
                // Why skipped: Claude Code marks its own injected messages as "<synthetic>".
                if (!value.StartsWith("<", StringComparison.Ordinal))
                {
                    last = value;
                }
            }

            return last;
        }

        /// <summary>"claude-opus-5-5" becomes "Claude Opus 5.5", "gpt-5.1-codex" becomes "GPT-5.1 Codex".</summary>
        public static string PrettyName(string raw)
        {
            var id = raw.Trim();
            var bracket = id.IndexOf('[');
            if (bracket > 0)
            {
                id = id.Substring(0, bracket);
            }

            // Why: a router prefixes the provider, as in "anthropic/claude-haiku-4-5".
            id = id.Substring(id.LastIndexOf('/') + 1);

            var parts = id.Split(new[] { '-', '_' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            if (parts.Count > 1 && Regex.IsMatch(parts[parts.Count - 1], "^[0-9]{8}$"))
            {
                parts.RemoveAt(parts.Count - 1);
            }

            var words = new List<string>();
            foreach (var part in parts)
            {
                var previous = words.Count > 0 ? words[words.Count - 1] : null;
                if (previous != null && IsVersion(part) && IsVersion(previous))
                {
                    words[words.Count - 1] = previous + "." + part;
                }
                else if (previous == "GPT" && char.IsDigit(part[0]))
                {
                    words[words.Count - 1] = "GPT-" + part;
                }
                else if (part.Equals("gpt", StringComparison.OrdinalIgnoreCase))
                {
                    words.Add("GPT");
                }
                else
                {
                    words.Add(char.ToUpperInvariant(part[0]) + part.Substring(1));
                }
            }

            return string.Join(" ", words);
        }

        private static bool IsVersion(string part) => part.Length > 0 && part.All(c => char.IsDigit(c) || c == '.');

        private static string? NonEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

        private static string? NewestClaudeSession(string claudeHome, string worktreePath)
        {
            var projects = Path.Combine(claudeHome, "projects");
            if (!Directory.Exists(projects))
            {
                return null;
            }

            var slug = ClaudeProjectSlug(worktreePath.TrimEnd('/', '\\'));
            // Why case-insensitive: Windows paths are, and one folder can appear as both D: and d:.
            return Directory.GetDirectories(projects)
                .Where(dir => string.Equals(Path.GetFileName(dir), slug, StringComparison.OrdinalIgnoreCase))
                .SelectMany(dir => new DirectoryInfo(dir).GetFiles("*.jsonl"))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .FirstOrDefault()?.FullName;
        }

        private static string? NewestCodexSession(string codexHome, string worktreePath)
        {
            var sessions = new DirectoryInfo(Path.Combine(codexHome, "sessions"));
            if (!sessions.Exists)
            {
                return null;
            }

            var wanted = NormalizePath(worktreePath);
            var recent = sessions.GetFiles("rollout-*.jsonl", SearchOption.AllDirectories)
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Take(CodexSessionsScanned);
            foreach (var file in recent)
            {
                var cwd = CwdField.Match(ReadHead(file.FullName));
                if (cwd.Success && NormalizePath(JsonSerializer.Deserialize<string>(cwd.Groups[1].Value) ?? "") == wanted)
                {
                    return file.FullName;
                }
            }

            return null;
        }

        private static string NormalizePath(string path) => path.Replace('\\', '/').TrimEnd('/').ToLowerInvariant();

        private static string ReadTail(string path)
        {
            // Why ReadWrite sharing: the agent is appending to this file while we read it.
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var start = Math.Max(0, stream.Length - TailBytes);
                stream.Seek(start, SeekOrigin.Begin);
                var buffer = new byte[stream.Length - start];
                var read = stream.Read(buffer, 0, buffer.Length);
                return Encoding.UTF8.GetString(buffer, 0, read);
            }
        }

        private static string ReadHead(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buffer = new byte[Math.Min(HeadBytes, stream.Length)];
                var read = stream.Read(buffer, 0, buffer.Length);
                return Encoding.UTF8.GetString(buffer, 0, read);
            }
        }
    }
}
