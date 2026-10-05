using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OrcaPresence
{
    /// <summary>
    /// Runtime configuration. Precedence: environment variable, then config.json, then the default.
    /// </summary>
    public sealed class AppConfig
    {
        /// <summary>
        /// A Discord application id is a public identifier, not a secret, so it ships baked in
        /// and the app works with no setup.
        /// </summary>
        public const string DefaultClientId = "1556649058657902712";

        /// <summary>Discord allows about 5 activity updates per 20 seconds.</summary>
        public const int DefaultPollMs = 15_000;

        public const int MinPollMs = 5_000;

        public string ClientId { get; set; } = DefaultClientId;

        public int PollMs { get; set; } = DefaultPollMs;

        /// <summary>True once the artwork is uploaded to the Discord application under matching keys.</summary>
        public bool UseUploadedArt { get; set; }

        public static AppConfig Load()
        {
            var config = new AppConfig();

            var fromFile = ReadConfigFile();
            if (fromFile != null)
            {
                if (!string.IsNullOrWhiteSpace(fromFile.ClientId))
                {
                    config.ClientId = fromFile.ClientId!;
                }

                if (fromFile.PollMs.HasValue && fromFile.PollMs.Value >= MinPollMs)
                {
                    config.PollMs = fromFile.PollMs.Value;
                }

                config.UseUploadedArt = fromFile.UseUploadedArt;
            }

            var envClientId = Environment.GetEnvironmentVariable("ORCA_DISCORD_CLIENT_ID");
            if (!string.IsNullOrWhiteSpace(envClientId))
            {
                config.ClientId = envClientId!;
            }

            if (Environment.GetEnvironmentVariable("ORCA_DISCORD_UPLOADED_ART") == "1")
            {
                config.UseUploadedArt = true;
            }

            return config;
        }

        private static ConfigFile? ReadConfigFile()
        {
            try
            {
                var path = ConfigPath();
                if (!File.Exists(path))
                {
                    return null;
                }

                return JsonSerializer.Deserialize<ConfigFile>(File.ReadAllText(path));
            }
            catch
            {
                // Why tolerated: a corrupt config must not stop the app from starting.
                return null;
            }
        }

        private static string ConfigPath()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "orca-discord-rpc", "config.json");
        }

        private sealed class ConfigFile
        {
            [JsonPropertyName("clientId")] public string? ClientId { get; set; }

            [JsonPropertyName("pollMs")] public int? PollMs { get; set; }

            [JsonPropertyName("useUploadedArt")] public bool UseUploadedArt { get; set; }
        }
    }
}
