using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace OrcaPresence
{
    /// <summary>
    /// The pure half of Discord's local IPC protocol: framing and payload construction.
    /// Verified against a live client: an unknown client id closes the socket with body
    /// {"code":4000,"message":"Invalid Client ID"}.
    /// </summary>
    public static class DiscordIpc
    {
        /// <summary>Handshake opcode.</summary>
        public const int OpHandshake = 0;

        /// <summary>Frame opcode.</summary>
        public const int OpFrame = 1;

        /// <summary>Close opcode; the body carries the error.</summary>
        public const int OpClose = 2;

        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        /// <summary>Writes little-endian opcode, then the UTF-8 byte length, then the body.</summary>
        public static byte[] BuildFrame(int opcode, string json)
        {
            var body = Utf8.GetBytes(json);
            var frame = new byte[8 + body.Length];
            BitConverter.GetBytes(opcode).CopyTo(frame, 0);
            BitConverter.GetBytes(body.Length).CopyTo(frame, 4);
            body.CopyTo(frame, 8);
            return frame;
        }

        public static int FrameOpcode(byte[] frame) => BitConverter.ToInt32(frame, 0);

        public static int FrameLength(byte[] frame) => BitConverter.ToInt32(frame, 4);

        public static string BuildHandshake(string clientId) =>
            "{\"v\":1,\"client_id\":\"" + clientId + "\"}";

        public static string BuildSetActivityPayload(PresenceActivity activity, string nonce, int pid)
        {
            var body = new StringBuilder();
            body.Append("{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"").Append(nonce).Append("\",\"args\":{");
            body.Append("\"pid\":").Append(pid).Append(',');
            body.Append("\"activity\":").Append(BuildActivityObject(activity));
            body.Append("}}");
            return body.ToString();
        }

        public static string BuildClearPayload(string nonce, int pid) =>
            "{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"" + nonce + "\",\"args\":{\"pid\":" + pid +
            ",\"activity\":null}}";

        /// <summary>Discord closes the socket with opcode 2 and this shape in the body.</summary>
        public static bool IsErrorFrame(string frameBody)
        {
            try
            {
                using var document = JsonDocument.Parse(frameBody);
                var root = document.RootElement;
                return root.ValueKind == JsonValueKind.Object &&
                       root.TryGetProperty("code", out _) &&
                       !root.TryGetProperty("cmd", out _);
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>The pipe names to try, in order, for this platform.</summary>
        public static string[] HandshakeCandidates()
        {
            var list = new string[10];
            for (var i = 0; i < list.Length; i++)
            {
                list[i] = BasePath() + "discord-ipc-" + i;
            }

            return list;
        }

        private static string BasePath()
        {
            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
            {
                return @"\\.\pipe\";
            }

            if (Environment.OSVersion.Platform == PlatformID.MacOSX)
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                return Path.Combine(home, "Library", "Application Support", "discord") + Path.DirectorySeparatorChar;
            }

            var runtime = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
            var dir = string.IsNullOrEmpty(runtime) ? "/tmp" : runtime!;
            return dir.TrimEnd('/') + "/";
        }

        private static string BuildActivityObject(PresenceActivity activity)
        {
            var parts = new List<string>
            {
                "\"details\":" + JsonSerializer.Serialize(activity.Details),
                "\"state\":" + JsonSerializer.Serialize(activity.State)
            };

            // Why guarded: a default or out-of-range timestamp would throw here, and a missing
            // timer is better than no presence at all.
            var start = ToUnixMilliseconds(activity.StartTimestamp);
            if (start.HasValue)
            {
                parts.Add("\"timestamps\":{\"start\":" + start.Value + "}");
            }

            var assets = BuildAssets(activity);
            if (assets != null)
            {
                parts.Add("\"assets\":" + assets);
            }

            return "{" + string.Join(",", parts) + "}";
        }

        /// <summary>Null when the timestamp cannot be expressed as a Unix time.</summary>
        private static long? ToUnixMilliseconds(DateTime timestamp)
        {
            if (timestamp == default(DateTime))
            {
                return null;
            }

            try
            {
                return new DateTimeOffset(timestamp.ToUniversalTime()).ToUnixTimeMilliseconds();
            }
            catch (ArgumentOutOfRangeException)
            {
                return null;
            }
        }

        private static string? BuildAssets(PresenceActivity activity)
        {
            var parts = new List<string>();
            AppendField(parts, "large_image", activity.LargeImageKey);
            AppendField(parts, "large_text", activity.LargeImageText);
            AppendField(parts, "small_image", activity.SmallImageKey ?? activity.SmallImageUrl);
            AppendField(parts, "small_text", activity.SmallImageText);
            return parts.Count == 0 ? null : "{" + string.Join(",", parts) + "}";
        }

        private static void AppendField(List<string> parts, string name, string? value)
        {
            if (!string.IsNullOrEmpty(value))
            {
                parts.Add("\"" + name + "\":" + JsonSerializer.Serialize(value));
            }
        }
    }

    /// <summary>
    /// The live transport. Connect-on-demand, with a quiet failure mode: Discord is frequently
    /// not running, and that must never take the tray down.
    /// </summary>
    public sealed class DiscordPresence : IDisposable
    {
        private readonly string _clientId;
        private readonly Func<int> _pid;
        private NamedPipeClientStream? _pipe;
        private bool _connected;

        public DiscordPresence(string clientId, Func<int>? pid = null)
        {
            _clientId = clientId;
            _pid = pid ?? (() => Process.GetCurrentProcess().Id);
        }

        /// <summary>Increments whenever the socket drops, so a caller knows to re-push.</summary>
        public int ConnectionGeneration { get; private set; }

        /// <summary>True while the client believes it holds a live session.</summary>
        public bool IsConnected => _connected;

        public bool Apply(PresenceActivity activity)
        {
            try
            {
                var body = Send(
                    DiscordIpc.BuildSetActivityPayload(activity, Guid.NewGuid().ToString(), _pid()), 5000);
                return !DiscordIpc.IsErrorFrame(body);
            }
            catch
            {
                Drop();
                return false;
            }
        }

        public bool Clear()
        {
            try
            {
                Send(DiscordIpc.BuildClearPayload(Guid.NewGuid().ToString(), _pid()), 5000);
                // Why released: nothing is displayed after a clear, so reporting "connected" would
                // tell the menu the profile is fine while it shows no activity at all.
                _connected = false;
                return true;
            }
            catch
            {
                Drop();
                return false;
            }
        }

        public void Dispose()
        {
            try
            {
                _pipe?.Dispose();
            }
            catch
            {
                // Why tolerated: a dispose failure must not surface during shutdown.
            }

            _pipe = null;
            _connected = false;
        }

        private string Send(string payload, int timeoutMs)
        {
            EnsureConnected(timeoutMs);
            var pipe = _pipe!;

            var frame = DiscordIpc.BuildFrame(DiscordIpc.OpFrame, payload);
            pipe.Write(frame, 0, frame.Length);
            pipe.Flush();

            var header = ReadExactly(pipe, 8, timeoutMs);
            if (header == null)
            {
                throw new IOException("Discord closed the connection");
            }

            var length = DiscordIpc.FrameLength(header);
            var body = length > 0 ? ReadExactly(pipe, length, timeoutMs) : new byte[0];
            if (body == null)
            {
                throw new IOException("Discord truncated the reply");
            }

            var text = Encoding.UTF8.GetString(body);
            if (DiscordIpc.IsErrorFrame(text))
            {
                throw new IOException("Discord rejected the activity: " + text);
            }

            return text;
        }

        private void EnsureConnected(int timeoutMs)
        {
            if (_pipe != null && _connected)
            {
                return;
            }

            _pipe?.Dispose();
            _pipe = null;

            var pipe = new NamedPipeClientStream(".", "discord-ipc-0", PipeDirection.InOut);
            pipe.Connect(timeoutMs);

            var handshake = DiscordIpc.BuildFrame(
                DiscordIpc.OpHandshake, DiscordIpc.BuildHandshake(_clientId));
            pipe.Write(handshake, 0, handshake.Length);
            pipe.Flush();

            // The client answers the handshake with a dispatch frame; an error frame here means the
            // client id was refused, so the connection is not usable.
            var header = ReadExactly(pipe, 8, timeoutMs);
            if (header == null)
            {
                pipe.Dispose();
                throw new IOException("Discord closed the handshake");
            }

            var length = DiscordIpc.FrameLength(header);
            var body = length > 0 ? ReadExactly(pipe, length, timeoutMs) : new byte[0];
            var text = body == null ? "" : Encoding.UTF8.GetString(body);
            if (DiscordIpc.IsErrorFrame(text))
            {
                pipe.Dispose();
                throw new IOException("Discord refused the client id: " + text);
            }

            _pipe = pipe;
            _connected = true;
        }

        private void Drop()
        {
            _connected = false;
            ConnectionGeneration++;
            try
            {
                _pipe?.Dispose();
            }
            catch
            {
                // ignore
            }

            _pipe = null;
        }

        private static byte[]? ReadExactly(Stream stream, int count, int timeoutMs)
        {
            var buffer = new byte[count];
            var read = 0;
            var deadline = Environment.TickCount + timeoutMs;
            while (read < count)
            {
                if (Environment.TickCount > deadline)
                {
                    throw new IOException("Discord did not answer in time");
                }

                var chunk = stream.Read(buffer, read, count - read);
                if (chunk <= 0)
                {
                    return null;
                }

                read += chunk;
            }

            return buffer;
        }
    }
}
