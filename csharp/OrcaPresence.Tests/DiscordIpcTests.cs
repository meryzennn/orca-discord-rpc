using System;
using System.Text;
using System.Text.Json;
using Xunit;

namespace OrcaPresence.Tests
{
    public class DiscordIpcTests
    {
        private static readonly DateTime Started =
            new DateTime(2026, 10, 5, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void FrameCarriesTheOpcodeAndTheLengthLittleEndian()
        {
            const string body = "{\"v\":1}";
            var frame = DiscordIpc.BuildFrame(0, body);
            Assert.Equal(0, BitConverter.ToInt32(frame, 0));
            Assert.Equal(Encoding.UTF8.GetByteCount(body), BitConverter.ToInt32(frame, 4));
            Assert.Equal(body, Encoding.UTF8.GetString(frame, 8, frame.Length - 8));
        }

        [Fact]
        public void FrameMeasuresTheBodyInBytesNotCharacters()
        {
            // Why: the middle dot is two bytes in UTF-8, and the length must count bytes.
            const string body = "{\"state\":\"a · b\"}";
            var frame = DiscordIpc.BuildFrame(1, body);
            Assert.Equal(Encoding.UTF8.GetByteCount(body), BitConverter.ToInt32(frame, 4));
            Assert.Equal(frame.Length - 8, BitConverter.ToInt32(frame, 4));
        }

        [Fact]
        public void HandshakeUsesTheClientIdAndProtocolVersion()
        {
            var json = DiscordIpc.BuildHandshake("1556649058657902712");
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(1, doc.RootElement.GetProperty("v").GetInt32());
            Assert.Equal("1556649058657902712", doc.RootElement.GetProperty("client_id").GetString());
        }

        [Fact]
        public void ActivityPayloadUsesTheSetActivityCommand()
        {
            var activity = new PresenceActivity { Details = "Claude", State = "orca · Working" };
            using var doc = JsonDocument.Parse(
                DiscordIpc.BuildSetActivityPayload(activity, "nonce-1", 4242));

            Assert.Equal("SET_ACTIVITY", doc.RootElement.GetProperty("cmd").GetString());
            Assert.Equal("nonce-1", doc.RootElement.GetProperty("nonce").GetString());

            var args = doc.RootElement.GetProperty("args");
            Assert.Equal(4242, args.GetProperty("pid").GetInt32());
            var body = args.GetProperty("activity");
            Assert.Equal("Claude", body.GetProperty("details").GetString());
            Assert.Equal("orca · Working", body.GetProperty("state").GetString());
        }

        [Fact]
        public void ActivityTimestampIsEpochMilliseconds()
        {
            // Why a typed expression: a hardcoded literal in this test was a year off.
            var activity = new PresenceActivity { Details = "Claude", State = "orca", StartTimestamp = Started };
            var expected = new DateTimeOffset(Started).ToUnixTimeMilliseconds();

            using var doc = JsonDocument.Parse(DiscordIpc.BuildSetActivityPayload(activity, "n", 1));
            var start = doc.RootElement.GetProperty("args").GetProperty("activity")
                .GetProperty("timestamps").GetProperty("start").GetInt64();

            Assert.Equal(expected, start);
        }

        [Fact]
        public void ActivityNamesTheUploadedAssetKeys()
        {
            var activity = new PresenceActivity
            {
                Details = "Claude", State = "orca",
                LargeImageKey = "claude", LargeImageText = "Agent",
                SmallImageKey = "git-branch", SmallImageText = "feat/x"
            };
            using var doc = JsonDocument.Parse(DiscordIpc.BuildSetActivityPayload(activity, "n", 1));
            var assets = doc.RootElement.GetProperty("args").GetProperty("activity").GetProperty("assets");

            Assert.Equal("claude", assets.GetProperty("large_image").GetString());
            Assert.Equal("git-branch", assets.GetProperty("small_image").GetString());
            Assert.Equal("feat/x", assets.GetProperty("small_text").GetString());
        }

        [Fact]
        public void ActivityNamesTheImageUrlsWhenNothingIsUploaded()
        {
            var activity = new PresenceActivity
            {
                Details = "Claude", State = "orca",
                LargeImageUrl = "https://example.test/a.png",
                SmallImageUrl = "https://example.test/b.png"
            };
            using var doc = JsonDocument.Parse(DiscordIpc.BuildSetActivityPayload(activity, "n", 1));
            var assets = doc.RootElement.GetProperty("args").GetProperty("activity").GetProperty("assets");

            Assert.Equal("https://example.test/a.png", assets.GetProperty("large_image").GetString());
            Assert.Equal("https://example.test/b.png", assets.GetProperty("small_image").GetString());
        }

        [Fact]
        public void ActivityOmitsAssetsWhenThereAreNone()
        {
            var activity = new PresenceActivity { Details = "Claude", State = "orca" };
            using var doc = JsonDocument.Parse(DiscordIpc.BuildSetActivityPayload(activity, "n", 1));
            var body = doc.RootElement.GetProperty("args").GetProperty("activity");

            // Why omitted and not null: an empty assets object is accepted, a null string is not.
            Assert.False(body.TryGetProperty("assets", out _));
        }

        [Fact]
        public void ClearingSendsANullActivity()
        {
            using var doc = JsonDocument.Parse(DiscordIpc.BuildClearPayload("nonce-2", 7));
            Assert.Equal("SET_ACTIVITY", doc.RootElement.GetProperty("cmd").GetString());
            var activity = doc.RootElement.GetProperty("args").GetProperty("activity");
            Assert.Equal(JsonValueKind.Null, activity.ValueKind);
        }

        [Fact]
        public void CandidatesCoverTheFirstTenPipes()
        {
            var list = DiscordIpc.HandshakeCandidates();
            Assert.Equal(10, list.Length);
            Assert.EndsWith("discord-ipc-0", list[0]);
            Assert.EndsWith("discord-ipc-9", list[9]);
        }

        [Fact]
        public void RecognisesAnErrorFrame()
        {
            // Captured from a live client: an unknown client id closes with this body.
            Assert.True(DiscordIpc.IsErrorFrame("{\"code\":4000,\"message\":\"Invalid Client ID\"}"));
            Assert.False(DiscordIpc.IsErrorFrame("{\"cmd\":\"SET_ACTIVITY\",\"data\":{}}"));
            Assert.False(DiscordIpc.IsErrorFrame("{\"evt\":\"READY\",\"data\":{}}"));
        }

        [Fact]
        public void ReadsTheFrameLengthOutOfAHeader()
        {
            var frame = DiscordIpc.BuildFrame(2, "{\"a\":1}");
            Assert.Equal(2, DiscordIpc.FrameOpcode(frame));
            Assert.Equal(7, DiscordIpc.FrameLength(frame));
        }
    }
}
