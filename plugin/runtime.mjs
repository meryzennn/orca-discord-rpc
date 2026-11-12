// src/orca-plugin.ts
import { tmpdir as tmpdir2 } from "node:os";

// src/discord-ipc.ts
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

// src/plugin-platform.ts
import { existsSync } from "node:fs";
import { win32, posix } from "node:path";
function resolveBundledCliEntry(executable, platform2, exists = existsSync) {
  const path = platform2 === "win32" ? win32 : posix;
  let resources;
  if (platform2 === "darwin") {
    const components = executable.split("/");
    const outerApp = components.findIndex((part, index) => part.toLowerCase().endsWith(".app") && components[index + 1] === "Contents");
    if (outerApp < 0) throw new Error("Could not locate the Orca app bundle");
    resources = path.join(components.slice(0, outerApp + 1).join("/"), "Contents", "Resources");
  } else if (platform2 === "win32" || platform2 === "linux") {
    resources = path.join(path.dirname(executable), "resources");
  } else {
    throw new Error(`Unsupported Orca desktop platform: ${platform2}`);
  }
  const entry = path.join(resources, "app.asar.unpacked", "out", "cli", "index.js");
  if (!exists(entry)) throw new Error("Could not locate the bundled Orca CLI entry");
  return entry;
}
function pluginDiscordPaths(platform2, temporaryDirectory, runtimeDirectory) {
  if (platform2 === "win32") {
    return [{ platform: ["win32"], format: (id) => String.raw`\\?\pipe\discord-ipc-${id}` }];
  }
  if (platform2 !== "darwin" && platform2 !== "linux") throw new Error(`Unsupported IPC platform: ${platform2}`);
  const roots = [...new Set([runtimeDirectory, temporaryDirectory, "/tmp"].filter(
    (root) => typeof root === "string" && root.length > 0
  ))];
  const suffixes = platform2 === "linux" ? [
    "",
    "snap.discord",
    "app/com.discordapp.Discord",
    "app/com.discordapp.DiscordCanary",
    "app/com.discordapp.DiscordPTB",
    "app/dev.vencord.Vesktop"
  ] : [""];
  return roots.flatMap((root) => suffixes.map((suffix) => ({
    platform: [platform2],
    format: (id) => posix.join(root, suffix, `discord-ipc-${id}`)
  })));
}

// src/discord-ipc.ts
var MAX_FRAME_BYTES = 1024 * 1024;
var error = (code) => Object.assign(new Error("Discord IPC request failed"), { code });
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function peerError(value) {
  return error(record(value) && typeof value.code === "number" && Number.isSafeInteger(value.code) ? value.code : 0);
}
function activityPayload(input) {
  const assets = {};
  for (const [key, value] of [
    ["large_image", input.largeImageKey || input.largeImageUrl],
    ["large_text", input.largeImageText],
    ["small_image", input.smallImageKey || input.smallImageUrl],
    ["small_text", input.smallImageText]
  ]) if (key && value) assets[key] = value;
  const start = input.startTimestamp?.getTime();
  return {
    type: 0,
    created_at: Date.now(),
    instance: false,
    ...input.details ? { details: input.details } : {},
    ...input.state ? { state: input.state } : {},
    ...start !== void 0 && Number.isFinite(start) ? { timestamps: { start } } : {},
    ...Object.keys(assets).length ? { assets } : {},
    ...input.buttons?.length ? { buttons: input.buttons } : {}
  };
}
function defaultPaths() {
  const uid = process.getuid?.();
  const runtime = process.env.XDG_RUNTIME_DIR || (process.platform === "linux" && uid !== void 0 ? `/run/user/${uid}` : void 0);
  return pluginDiscordPaths(process.platform, tmpdir(), runtime);
}
function createDiscordIpcClient(clientId, paths = defaultPaths()) {
  const events = new EventEmitter();
  const pending = /* @__PURE__ */ new Map();
  const candidates = [...new Set(paths.filter((path) => path.platform.includes(process.platform)).flatMap((path) => Array.from({ length: 10 }, (_, id) => path.format(id))))];
  let socket = null;
  let buffer = Buffer.alloc(0);
  let connected = false;
  let ended = false;
  let closing = Promise.resolve();
  let loginJob = null;
  let resolveLogin = null;
  let rejectLogin = null;
  let loginTimer;
  let heartbeat;
  let stale;
  let ping = null;
  const stop = (reason) => {
    if (ended) return;
    ended = true;
    connected = false;
    clearTimeout(loginTimer);
    clearTimeout(stale);
    clearInterval(heartbeat);
    rejectLogin?.(reason);
    resolveLogin = rejectLogin = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(reason);
    }
    pending.clear();
    buffer = Buffer.alloc(0);
    const current = socket;
    socket = null;
    if (current && !current.closed) {
      closing = new Promise((resolve) => current.once("close", resolve));
      current.destroy();
    }
    events.emit("disconnected");
  };
  const send = (opcode, payload) => {
    if (ended || !socket) return;
    try {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      if (body.length > MAX_FRAME_BYTES) {
        stop(error("FRAME_TOO_LARGE"));
        return;
      }
      const header = Buffer.alloc(8);
      header.writeUInt32LE(opcode, 0);
      header.writeUInt32LE(body.length, 4);
      socket.write(Buffer.concat([header, body]), (reason) => {
        if (reason) stop(reason);
      });
    } catch {
      stop(error("INVALID_PAYLOAD"));
    }
  };
  const keepAlive = () => {
    clearTimeout(stale);
    stale = setTimeout(() => stop(error("HEARTBEAT_TIMEOUT")), 3e4);
    stale.unref();
  };
  const receive = (chunk) => {
    if (ended) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (!ended && buffer.length >= 8) {
      const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) {
        stop(error("FRAME_TOO_LARGE"));
        return;
      }
      if (buffer.length < 8 + length) return;
      const bytes = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);
      let payload;
      try {
        payload = length ? JSON.parse(bytes.toString("utf8")) : null;
      } catch {
        stop(error("INVALID_FRAME"));
        return;
      }
      if (opcode === 2) {
        stop(peerError(payload));
        return;
      }
      if (opcode === 3) {
        send(4, payload);
        continue;
      }
      if (opcode === 4) {
        if (payload === ping) keepAlive();
        continue;
      }
      if (opcode !== 1 || !record(payload)) {
        stop(error("INVALID_FRAME"));
        return;
      }
      if (!connected && payload.cmd === "DISPATCH" && payload.evt === "READY") {
        if (!record(payload.data) || !record(payload.data.user)) {
          stop(error("INVALID_FRAME"));
          return;
        }
        connected = true;
        clearTimeout(loginTimer);
        resolveLogin?.();
        resolveLogin = rejectLogin = null;
        keepAlive();
        heartbeat = setInterval(() => {
          ping = randomUUID();
          send(3, ping);
        }, 5e3);
        heartbeat.unref();
        continue;
      }
      if (payload.cmd !== "SET_ACTIVITY" || typeof payload.nonce !== "string") continue;
      const job = pending.get(payload.nonce);
      if (!job) continue;
      pending.delete(payload.nonce);
      clearTimeout(job.timer);
      if (payload.evt === "ERROR") job.reject(peerError(payload.data));
      else job.resolve(payload.data);
    }
  };
  const connectPath = (path) => new Promise((resolve, reject) => {
    const candidate = createConnection(path);
    socket = candidate;
    const cleanup = () => {
      candidate.removeListener("connect", accept);
      candidate.removeListener("error", refuse);
      candidate.removeListener("close", closed);
    };
    const refuse = (reason) => {
      cleanup();
      if (socket === candidate) socket = null;
      candidate.destroy();
      reject(reason);
    };
    const closed = () => refuse(error(0));
    const accept = () => {
      cleanup();
      resolve(candidate);
    };
    candidate.once("connect", accept);
    candidate.once("error", refuse);
    candidate.once("close", closed);
  });
  const open = async () => {
    for (const path of candidates) {
      if (ended) return;
      let candidate;
      try {
        candidate = await connectPath(path);
      } catch {
        if (ended) return;
        continue;
      }
      if (ended || socket !== candidate) {
        candidate.destroy();
        return;
      }
      candidate.on("data", receive);
      candidate.on("error", stop);
      candidate.on("close", () => stop(error(0)));
      send(0, { v: 1, client_id: clientId });
      return;
    }
    stop(error(2));
  };
  const request = (activity) => {
    if (!connected || ended) return Promise.reject(error(4));
    return new Promise((resolve, reject) => {
      const nonce = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(nonce);
        reject(error(5));
      }, 6e4);
      pending.set(nonce, { resolve, reject, timer });
      send(1, { cmd: "SET_ACTIVITY", nonce, args: { pid: process.pid, activity } });
    });
  };
  const user = {
    setActivity: (activity) => request(activityPayload(activity)),
    clearActivity: async () => {
      await request(null);
    }
  };
  return {
    on: (event, listener) => events.on(event, listener),
    login: () => {
      if (ended) return Promise.reject(error(0));
      if (loginJob) return loginJob;
      loginJob = new Promise((resolve, reject) => {
        resolveLogin = resolve;
        rejectLogin = reject;
        loginTimer = setTimeout(() => stop(error(1)), 1e4);
        void open().catch(() => stop(error(2)));
      });
      return loginJob;
    },
    destroy: async () => {
      stop(error(0));
      await closing;
    },
    get user() {
      return connected && !ended ? user : void 0;
    }
  };
}

// config/agents.json
var agents_default = {
  fallback: {
    asset: "orca",
    imageUrl: "https://www.google.com/s2/favicons?domain=onorca.dev&sz=256"
  },
  branchIcon: {
    asset: "git-branch",
    imageUrl: "https://www.google.com/s2/favicons?domain=git-scm.com&sz=128"
  },
  agents: {
    claude: {
      name: "Claude",
      asset: "claude",
      imageUrl: "https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-png/dark/claude-color.png",
      modelResolver: "claude"
    },
    "claude-agent-teams": {
      name: "Claude",
      asset: "claude",
      imageUrl: "https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-png/dark/claude-color.png",
      modelResolver: "claude"
    },
    codex: {
      name: "Codex",
      asset: "codex",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=256",
      modelResolver: "codex"
    },
    omp: {
      name: "Oh My Pi",
      asset: "omp",
      imageUrl: "https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png",
      modelResolver: "omp"
    },
    antigravity: {
      name: "Antigravity",
      asset: "agy",
      imageUrl: "https://www.google.com/s2/favicons?domain=antigravity.google&sz=256",
      modelResolver: "antigravity"
    },
    agy: {
      name: "Antigravity",
      asset: "agy",
      imageUrl: "https://www.google.com/s2/favicons?domain=antigravity.google&sz=256",
      modelResolver: "antigravity"
    },
    opencode: {
      name: "OpenCode",
      asset: "opencode",
      imageUrl: "https://www.google.com/s2/favicons?domain=opencode.ai&sz=256"
    },
    opencode2: {
      name: "OpenCode",
      asset: "opencode",
      imageUrl: "https://www.google.com/s2/favicons?domain=opencode.ai&sz=256"
    },
    "command-code": {
      name: "Command Code",
      asset: "commandcode",
      imageUrl: "https://www.google.com/s2/favicons?domain=commandcode.ai&sz=256"
    },
    dsh: {
      asset: "deepsek-harnnes",
      imageUrl: "https://www.google.com/s2/favicons?domain=deepseek.com&sz=256"
    },
    grok: {
      asset: "grock",
      imageUrl: "https://www.google.com/s2/favicons?domain=x.ai&sz=256"
    },
    hermes: {
      asset: "hermes",
      imageUrl: "https://www.google.com/s2/favicons?domain=hermes.nousresearch.com&sz=256"
    },
    cursor: {
      imageUrl: "https://www.google.com/s2/favicons?domain=cursor.com&sz=256"
    },
    gemini: {
      imageUrl: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=256"
    },
    copilot: {
      imageUrl: "https://www.google.com/s2/favicons?domain=github.com&sz=256"
    },
    amp: {
      imageUrl: "https://www.google.com/s2/favicons?domain=ampcode.com&sz=256"
    },
    aider: {
      imageUrl: "https://www.google.com/s2/favicons?domain=aider.chat&sz=256"
    },
    goose: {
      imageUrl: "https://www.google.com/s2/favicons?domain=block.github.io&sz=256"
    },
    devin: {
      imageUrl: "https://www.google.com/s2/favicons?domain=devin.ai&sz=256"
    },
    kimi: {
      imageUrl: "https://www.google.com/s2/favicons?domain=kimi.moonshot.cn&sz=256"
    },
    "qwen-code": {
      name: "Qwen Code"
    }
  }
};

// src/type-guards.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/agent-registry.ts
var FIELDS = ["name", "asset", "imageUrl", "modelResolver"];
function prettifyAgentId(id) {
  const words = id.split(/[-_\s]+/).filter((part) => part.length > 0).map((part) => {
    const [first = ""] = part;
    return first.toUpperCase() + part.slice(first.length);
  });
  return words.length > 0 ? words.join(" ") : id;
}
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
function readOverride(id, raw, note) {
  if (!isRecord(raw)) {
    note(`override:${id}`, `config.json agents.${JSON.stringify(id)} must be an object; ignored.`);
    return {};
  }
  const entry = {};
  for (const field2 of FIELDS) {
    const value = raw[field2];
    if (value === void 0) continue;
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const valid = text.length > 0 && (field2 === "imageUrl" ? isHttpsUrl(text) : true) && (field2 === "asset" || field2 === "modelResolver" ? !/\s/.test(text) : true);
    if (valid) entry[field2] = text;
    else note(
      `override:${id}:${field2}`,
      `config.json agents.${JSON.stringify(id)}.${field2} is not valid${field2 === "imageUrl" ? " (an https URL is required)" : ""}; ignored.`
    );
  }
  return entry;
}
function createAgentRegistry(options = {}) {
  const file = agents_default;
  const seen = /* @__PURE__ */ new Set();
  const noteOnce = (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    try {
      options.log?.(message);
    } catch {
    }
  };
  const entries = new Map(Object.entries(file.agents));
  const { overrides } = options;
  if (overrides !== void 0) {
    if (!isRecord(overrides)) {
      noteOnce("overrides", 'config.json "agents" must be an object of agent ids; ignored.');
    } else {
      for (const [id, raw] of Object.entries(overrides)) {
        entries.set(id, { ...entries.get(id), ...readOverride(id, raw, noteOnce) });
      }
    }
  }
  return {
    resolve(id) {
      const entry = entries.get(id);
      if (entry === void 0) {
        noteOnce(
          `unknown:${id}`,
          `Unknown agent id ${JSON.stringify(id.slice(0, 64))}: using a generated name and the fallback icon. Add it under "agents" in config.json to set a name, image and model resolver.`
        );
        return { id, name: prettifyAgentId(id), asset: null, imageUrl: null, modelResolver: null, known: false };
      }
      return {
        id,
        name: entry.name ?? prettifyAgentId(id),
        asset: entry.asset ?? null,
        imageUrl: entry.imageUrl ?? null,
        modelResolver: entry.modelResolver ?? null,
        known: true
      };
    },
    fallbackIcon: file.fallback,
    branchIcon: file.branchIcon,
    noteOnce
  };
}
var builtinRegistry = createAgentRegistry();

// src/agent-model.ts
import { homedir } from "node:os";

// src/model-resolvers/antigravity.ts
import { closeSync as closeSync2, existsSync as existsSync3, fstatSync as fstatSync2, openSync as openSync2, readFileSync, readSync as readSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/model-resolvers/session-files.ts
import { closeSync, existsSync as existsSync2, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
var TAIL_BYTES = 64 * 1024;
var MODEL_OVERLAP_BYTES = 1024;
var HEAD_BYTES = 16 * 1024;
var SESSIONS_SCANNED = 50;
var MODEL_FIELD = /"model":"([^"]+)"/g;
var CWD_FIELD = /"cwd":("(?:[^"\\]|\\.)*")/;
var IS_WINDOWS = process.platform === "win32";
function lastModelIn(text) {
  let last = null;
  for (const match of text.matchAll(MODEL_FIELD)) {
    const value = match[1] ?? "";
    if (!value.startsWith("<")) {
      last = value;
    }
  }
  return last;
}
function nonEmpty(value) {
  return value !== void 0 && value.trim().length > 0 ? value : void 0;
}
function samePath(a, b) {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
function newestOf(files) {
  let best = null;
  let bestAt = -Infinity;
  for (const file of files) {
    const at = statSync(file).mtimeMs;
    if (at > bestAt) {
      best = file;
      bestAt = at;
    }
  }
  return best;
}
function newestWorkspaceSession(sessions, worktreePath, layout) {
  if (!existsSync2(sessions)) {
    return null;
  }
  const wanted = normalizePath(worktreePath);
  const names = layout === "codex" ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) => basename(name).startsWith("rollout-") && name.endsWith(".jsonl")) : readdirSync(sessions, { withFileTypes: true }).flatMap((bucket) => bucket.isDirectory() ? readdirSync(join(sessions, bucket.name), { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith(".jsonl")).map((file) => join(bucket.name, file.name)) : []);
  const recent = names.map((name) => {
    const file = join(sessions, name);
    return { file, at: statSync(file).mtimeMs };
  }).sort((a, b) => b.at - a.at).slice(0, SESSIONS_SCANNED);
  for (const { file } of recent) {
    const cwd = CWD_FIELD.exec(readSlice(file, "head", HEAD_BYTES))?.[1];
    if (cwd !== void 0 && samePath(normalizePath(JSON.parse(cwd)), wanted)) {
      return file;
    }
  }
  return null;
}
function readLastModel(path, parse) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    let position = Math.max(0, size - TAIL_BYTES);
    while (true) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      const model = parse(buffer.toString("utf8", 0, read));
      if (model !== null || position === 0) return model;
      position = Math.max(0, position - TAIL_BYTES + MODEL_OVERLAP_BYTES);
    }
  } finally {
    closeSync(fd);
  }
}
function readSlice(path, end, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, end === "tail" ? size - length : 0);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

// src/model-resolvers/antigravity.ts
var SETTINGS_CHANGE = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g;
var MODEL_CHANGE = /`Model Selection` (?:from [^\n`]+? )?to ([^\n`]+?)(?:\.\s|\.?$)/g;
function lastAntigravityModelIn(text) {
  let last = null;
  for (const line of text.split("\n")) {
    let content;
    try {
      const entry = JSON.parse(line);
      if (entry === null || typeof entry !== "object" || !("source" in entry) || entry.source !== "USER_EXPLICIT" || !("content" in entry)) continue;
      content = entry.content;
    } catch {
      continue;
    }
    if (typeof content !== "string") continue;
    for (const change of content.matchAll(SETTINGS_CHANGE)) {
      for (const match of (change[1] ?? "").matchAll(MODEL_CHANGE)) {
        const model = match[1]?.trim();
        if (model && !model.startsWith("<")) last = model;
      }
    }
  }
  return last;
}
function defaultAntigravityModel(agyHome) {
  for (const dir of [agyHome, join2(agyHome, "..")]) {
    const settings = join2(dir, "settings.json");
    if (!existsSync3(settings)) continue;
    try {
      const raw = JSON.parse(readFileSync(settings, "utf8").replace(/^\uFEFF/, ""));
      if (raw && typeof raw === "object" && "model" in raw && typeof raw.model === "string" && raw.model.trim()) {
        return raw.model.trim();
      }
    } catch {
    }
  }
  return null;
}
function newestAntigravityConversation(agyHome, worktreePath) {
  const history = join2(agyHome, "history.jsonl");
  if (!existsSync3(history)) return null;
  const wanted = normalizePath(worktreePath);
  const fd = openSync2(history, "r");
  try {
    const size = fstatSync2(fd).size;
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    let position = Math.max(0, size - buffer.length);
    while (position >= 0) {
      const read = readSync2(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      const lines = buffer.toString("utf8", 0, read).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === "object" && "workspace" in entry && typeof entry.workspace === "string") {
            if (samePath(normalizePath(entry.workspace), wanted) && "conversationId" in entry && typeof entry.conversationId === "string") {
              return entry.conversationId;
            }
          }
        } catch {
        }
      }
      if (position === 0) break;
      position = Math.max(0, position - TAIL_BYTES + MODEL_OVERLAP_BYTES);
    }
  } finally {
    closeSync2(fd);
  }
  return null;
}
function newestAntigravityModel(agyHome, worktreePath) {
  if (!existsSync3(agyHome)) return null;
  const conversationId = newestAntigravityConversation(agyHome, worktreePath);
  if (conversationId) {
    const transcript = join2(agyHome, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync3(transcript)) {
      const fromTranscript = readLastModel(transcript, lastAntigravityModelIn);
      if (fromTranscript) return fromTranscript;
    }
  }
  return defaultAntigravityModel(agyHome);
}
var resolveAntigravityModel = (worktreePath, sources) => newestAntigravityModel(nonEmpty(sources.env("ANTIGRAVITY_HOME")) ?? join2(sources.home, ".gemini", "antigravity-cli"), worktreePath);

// src/model-resolvers/claude.ts
import { existsSync as existsSync4, readdirSync as readdirSync2 } from "node:fs";
import { join as join3 } from "node:path";
function claudeProjectSlug(path) {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
function newestClaudeSession(claudeHome, worktreePath) {
  const projects = join3(claudeHome, "projects");
  if (!existsSync4(projects)) {
    return null;
  }
  const slug = claudeProjectSlug(worktreePath.replace(/[/\\]+$/, ""));
  const files = readdirSync2(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && samePath(entry.name, slug)).flatMap(
    (entry) => readdirSync2(join3(projects, entry.name)).filter((name) => name.endsWith(".jsonl")).map((name) => join3(projects, entry.name, name))
  );
  return newestOf(files);
}
var resolveClaudeModel = (worktreePath, sources) => {
  const log = newestClaudeSession(nonEmpty(sources.env("CLAUDE_CONFIG_DIR")) ?? join3(sources.home, ".claude"), worktreePath);
  return log === null ? null : readLastModel(log, lastModelIn);
};

// src/model-resolvers/codex.ts
import { join as join4 } from "node:path";
var resolveCodexModel = (worktreePath, sources) => {
  const codexHome = nonEmpty(sources.env("CODEX_HOME")) ?? join4(sources.home, ".codex");
  const log = newestWorkspaceSession(join4(codexHome, "sessions"), worktreePath, "codex");
  return log === null ? null : readLastModel(log, lastModelIn);
};

// src/model-resolvers/omp.ts
import { join as join5 } from "node:path";
function lastOmpModelIn(text) {
  let last = null;
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry === null || typeof entry !== "object" || !("type" in entry)) continue;
      let model = null;
      if (entry.type === "model_change" && "model" in entry) model = entry.model;
      else if (entry.type === "message" && "message" in entry) {
        const message = entry.message;
        if (message !== null && typeof message === "object" && "role" in message && message.role === "assistant" && "model" in message) model = message.model;
      }
      if (typeof model === "string" && model.trim() && !model.startsWith("<")) last = model;
    } catch {
    }
  }
  return last;
}
var resolveOmpModel = (worktreePath, sources) => {
  const agentDir = nonEmpty(sources.env("PI_CODING_AGENT_DIR")) ?? join5(sources.home, ".omp", "agent");
  const log = newestWorkspaceSession(join5(agentDir, "sessions"), worktreePath, "omp");
  return log === null ? null : readLastModel(log, lastOmpModelIn);
};

// src/model-resolvers/index.ts
var MODEL_RESOLVERS = {
  claude: resolveClaudeModel,
  codex: resolveCodexModel,
  omp: resolveOmpModel,
  antigravity: resolveAntigravityModel
};
function modelResolverFor(id) {
  return Object.hasOwn(MODEL_RESOLVERS, id) ? MODEL_RESOLVERS[id] ?? null : null;
}

// src/agent-model.ts
var defaultSources = { env: (name) => process.env[name], home: homedir() };
function findAgentModel(agentType, worktreePath, sources = defaultSources, registry = builtinRegistry) {
  if (!agentType || !worktreePath) {
    return null;
  }
  const agent = registry.resolve(agentType);
  if (agent.modelResolver === null) {
    return null;
  }
  const resolver = modelResolverFor(agent.modelResolver);
  if (resolver === null) {
    registry.noteOnce(
      `resolver:${agent.modelResolver}`,
      `Agent ${JSON.stringify(agentType.slice(0, 64))} names the unknown model resolver ${JSON.stringify(agent.modelResolver.slice(0, 64))}; showing the agent name instead.`
    );
    return null;
  }
  try {
    const raw = resolver(worktreePath, sources);
    return raw === null ? null : prettyModelName(raw);
  } catch (error2) {
    const code = error2 instanceof Error && "code" in error2 && typeof error2.code === "string" ? error2.code : "error";
    registry.noteOnce(
      `model:${agentType}:${code}`,
      `Model lookup for agent ${JSON.stringify(agentType.slice(0, 64))} failed (${code}); showing the agent name instead.`
    );
    return null;
  }
}
function prettyModelName(raw) {
  let id = raw.trim();
  const bracket = id.indexOf("[");
  if (bracket > 0) {
    id = id.slice(0, bracket);
  }
  id = id.slice(id.lastIndexOf("/") + 1);
  const parts = id.split(/[-_]/).filter((part) => part.length > 0);
  if (parts.length > 1 && /^[0-9]{8}$/.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  const words = [];
  for (const part of parts) {
    const previous = words[words.length - 1];
    if (previous !== void 0 && isVersion(part) && isVersion(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
    } else if (previous === "GPT" && /^[0-9]/.test(part)) {
      words[words.length - 1] = `GPT-${part}`;
    } else if (part.toLowerCase() === "gpt") {
      words.push("GPT");
    } else {
      words.push(part[0].toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}
function isVersion(part) {
  return /^[0-9.]+$/.test(part);
}

// src/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
var DEFAULT_CLIENT_ID = "1556649058657902712";
var DEFAULT_POLL_MS = 15e3;
var MIN_POLL_MS = 5e3;
function readPollMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_POLL_MS) {
    return DEFAULT_POLL_MS;
  }
  return Math.trunc(value);
}
function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  let file = null;
  try {
    file = options.readConfigFile?.() ?? null;
  } catch {
    file = null;
  }
  const envClientId = env.ORCA_DISCORD_CLIENT_ID;
  const fileClientId = typeof file?.clientId === "string" ? file.clientId : void 0;
  const clientId = envClientId && envClientId.length > 0 ? envClientId : fileClientId && fileClientId.length > 0 ? fileClientId : DEFAULT_CLIENT_ID;
  const useUploadedArt = env.ORCA_DISCORD_UPLOADED_ART === "1" || file?.useUploadedArt === true;
  return { clientId, pollMs: readPollMs(file?.pollMs), useUploadedArt, agents: file?.agents };
}
function readConfigFile(path, log) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch (error2) {
    const code = error2 instanceof Error && "code" in error2 ? error2.code : null;
    if (code !== "ENOENT") log?.("config.json could not be read; using defaults.");
    return null;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (isRecord(value)) return value;
    log?.("config.json must contain a JSON object; using defaults.");
  } catch {
    log?.("config.json is not valid JSON; using defaults.");
  }
  return null;
}

// src/paths.ts
import { join as join6 } from "node:path";
import { homedir as homedir2, platform } from "node:os";
function appDir() {
  if (platform() === "win32") {
    return join6(process.env.LOCALAPPDATA ?? join6(homedir2(), "AppData", "Local"), "orca-discord-rpc");
  }
  if (platform() === "darwin") {
    return join6(homedir2(), "Library", "Application Support", "orca-discord-rpc");
  }
  return join6(process.env.XDG_CONFIG_HOME ?? join6(homedir2(), ".config"), "orca-discord-rpc");
}
var configPath = () => join6(appDir(), "config.json");

// src/discord.ts
function createDiscordPresence(clientId, createClient = (id) => createDiscordIpcClient(id)) {
  let client = null;
  let connected = false;
  let visible = false;
  let generation = 0;
  let lifecycle2 = 0;
  let lastFailure = null;
  const failure = (operation, error2) => {
    const value = error2 !== null && typeof error2 === "object" && "code" in error2 ? error2.code : null;
    const code = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "unknown";
    lastFailure = `Discord RPC ${operation} failed (code: ${code})`;
  };
  const retire = async (current) => {
    if (client !== current) return;
    client = null;
    connected = false;
    visible = false;
    try {
      await current.destroy();
    } catch (error2) {
      if (client === null) {
        client = current;
        failure("destroy", error2);
      }
      throw error2;
    }
  };
  const ensureClient = async () => {
    if (client && connected) return client;
    const epoch = lifecycle2;
    if (client) {
      try {
        await retire(client);
      } catch {
        generation += 1;
        return null;
      }
    }
    if (epoch !== lifecycle2) return null;
    const next = createClient(clientId);
    client = next;
    visible = false;
    next.on("disconnected", () => {
      if (client !== next) return;
      connected = false;
      visible = false;
      lifecycle2 += 1;
      generation += 1;
    });
    try {
      await next.login();
    } catch (error2) {
      if (client === next) {
        connected = false;
        generation += 1;
        failure("login", error2);
        await retire(next).catch(() => {
        });
      }
      return null;
    }
    if (client !== next || epoch !== lifecycle2) {
      if (client === next) await retire(next).catch(() => {
      });
      return null;
    }
    connected = true;
    return next;
  };
  return {
    async apply(activity, canPublish) {
      let active = null;
      try {
        active = await ensureClient();
        const user = active?.user;
        if (!active || client !== active || !connected || !user || canPublish?.() === false) {
          return false;
        }
        const { largeImageUrl, smallImageUrl, ...normalizedActivity } = activity;
        if (!normalizedActivity.largeImageKey && largeImageUrl) normalizedActivity.largeImageKey = largeImageUrl;
        if (!normalizedActivity.smallImageKey && smallImageUrl) normalizedActivity.smallImageKey = smallImageUrl;
        await user.setActivity(normalizedActivity);
        if (client !== active || !connected) return false;
        lastFailure = null;
        visible = true;
        return true;
      } catch (error2) {
        if (active === null || client === active) {
          connected = false;
          generation += 1;
          failure(active === null ? "login" : "apply", error2);
        }
        return false;
      }
    },
    async clear() {
      const current = client;
      try {
        if (current && !current.user) {
          failure("clear", { code: 4 });
          return false;
        }
        await current?.user?.clearActivity();
        if (client === current) {
          visible = false;
          lastFailure = null;
        }
        return true;
      } catch (error2) {
        if (client === current) {
          connected = false;
          generation += 1;
          failure("clear", error2);
        }
        return false;
      }
    },
    async destroy() {
      lifecycle2 += 1;
      const epoch = lifecycle2;
      connected = false;
      const current = client;
      if (current) await retire(current);
      if (epoch === lifecycle2 && client === null) lastFailure = null;
    },
    connectionGeneration: () => generation,
    isConnected: () => connected && visible,
    lastError: () => lastFailure
  };
}

// src/orca-reader.ts
import { execFile } from "node:child_process";
import { homedir as homedir3 } from "node:os";
import { win32 as win322 } from "node:path";

// src/orca-state.ts
var LIVE_AGENT_STATES = /* @__PURE__ */ new Set(["working", "blocked", "waiting"]);
var MIN_AGENT_STATE_STARTED_AT = 1e12;
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function parseWorktreePs(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord2(parsed) || parsed.ok !== true || !isRecord2(parsed.result)) {
    return null;
  }
  const worktrees = parsed.result.worktrees;
  if (!Array.isArray(worktrees)) {
    return null;
  }
  return worktrees.filter(isRecord2).map((worktree) => ({
    ...worktree,
    agents: Array.isArray(worktree.agents) ? worktree.agents.filter(isRecord2) : []
  }));
}
function selectActiveWorktree(worktrees) {
  return worktrees.find((worktree) => worktree.isActive === true) ?? null;
}
function hasAgentType(agent) {
  return typeof agent.agentType === "string" && agent.agentType.length > 0;
}
function allAgents(worktree) {
  if (!worktree) {
    return [];
  }
  return (worktree.agents ?? []).filter(
    (agent) => typeof agent.state === "string" && hasAgentType(agent)
  );
}
function liveAgents(worktree) {
  return allAgents(worktree).filter((agent) => LIVE_AGENT_STATES.has(agent.state ?? ""));
}
function featuredAgent(worktree) {
  const live = liveAgents(worktree);
  const candidates = live.length > 0 ? live : allAgents(worktree);
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0] ?? null;
  let bestAt = stateStartedAtOf(best);
  for (const agent of candidates.slice(1)) {
    const startedAt = stateStartedAtOf(agent);
    if (startedAt > bestAt) {
      best = agent;
      bestAt = startedAt;
    }
  }
  return best;
}
function stateStartedAtOf(agent) {
  const value = agent?.stateStartedAt;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.NEGATIVE_INFINITY;
  }
  return value >= MIN_AGENT_STATE_STARTED_AT ? value : Number.NEGATIVE_INFINITY;
}
function projectNameFor(worktree) {
  const label = displayNameFor(worktree);
  const meta = worktree?.meta;
  const pinned = meta && typeof meta.displayNameIsPinned === "boolean" ? meta.displayNameIsPinned : false;
  if (label !== null && pinned) {
    return label;
  }
  const folder = folderNameFromPath(worktree?.path);
  return folder ?? label;
}
function displayNameFor(worktree) {
  const name = worktree?.displayName;
  return typeof name === "string" && name.length > 0 ? name : null;
}
function folderNameFromPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  const segment = path.split(/[\\/]/).filter((part) => part.length > 0).pop();
  return segment !== void 0 && segment.length > 0 ? segment : null;
}
function branchNameFor(worktree) {
  const branch = worktree?.branch;
  if (typeof branch !== "string" || branch.length === 0) {
    return null;
  }
  return branch.replace(/^refs\/heads\//, "");
}
function activityCounts(worktrees) {
  let runningAgentCount = 0;
  let activeWorkspaceCount = 0;
  for (const worktree of worktrees) {
    const count = allAgents(worktree).length;
    runningAgentCount += count;
    if (count > 0) activeWorkspaceCount += 1;
  }
  return { runningAgentCount, activeWorkspaceCount };
}

// src/orca-reader.ts
var ORCA_TIMEOUT_MS = 1e4;
var ORCA_COMMAND = process.platform === "win32" ? "orca.exe" : "orca";
function pluginCliEnv(env, platform2, userHome) {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    // Orca's Windows CLI needs this known folder to find its runtime metadata.
    ...platform2 === "win32" && env.APPDATA === void 0 ? { APPDATA: win322.join(userHome, "AppData", "Roaming") } : {}
  };
}
function runOrcaWorktreePs(command = ORCA_COMMAND, nodeEntry, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...nodeEntry ? [nodeEntry] : [], "worktree", "ps", "--json"],
      {
        timeout: ORCA_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: nodeEntry ? pluginCliEnv(process.env, process.platform, homedir3()) : process.env
      },
      (error2, stdout, stderr) => {
        if (error2) {
          let cliMessage = "";
          try {
            const response = JSON.parse(stdout);
            if (response?.ok === false && typeof response.error?.message === "string") {
              cliMessage = response.error.message.trim();
            }
          } catch {
          }
          const diagnostics = [cliMessage, stderr.trim()].filter((message) => message && !error2.message.includes(message));
          if (diagnostics.length) error2.message += `
${diagnostics.join("\n")}`;
          reject(error2);
          return;
        }
        resolve(stdout);
      }
    );
  });
}
async function readPresenceState(runWorktreePs = runOrcaWorktreePs, resolveRepoUrl, findModel = findAgentModel) {
  const worktrees = parseWorktreePs(await runWorktreePs());
  if (worktrees === null) return null;
  const active = selectActiveWorktree(worktrees);
  const path = typeof active?.path === "string" ? active.path : null;
  const featured = featuredAgent(active);
  const agentType = typeof featured?.agentType === "string" ? featured.agentType : null;
  return {
    projectName: projectNameFor(active),
    // Why the agent type and not a label: the builder owns naming and art for it.
    agentType,
    model: agentType === null ? null : findModel(agentType, path),
    ...activityCounts(worktrees),
    agentActive: featured?.state === "working",
    branchName: branchNameFor(active),
    ...resolveRepoUrl ? { repoUrl: path ? await resolveRepoUrl(path) : null } : {}
  };
}

// src/git-remote.ts
import { execFile as execFile2 } from "node:child_process";
function sanitizeRepoWebUrl(raw) {
  const source = raw?.trim();
  if (!source || /[\s\\\x00-\x1f\x7f]/.test(source) || !/^https?:\/\//i.test(source)) return null;
  try {
    const url = new URL(source);
    const path = url.pathname;
    if (!url.hostname || path === "/" || path.includes("//") || /[\\\x00-\x1f\x7f]/.test(decodeURIComponent(path))) return null;
    return new URL(`${url.protocol}//${url.hostname}${path}`).href;
  } catch {
    return null;
  }
}
function normalizeRepoUrl(raw) {
  const remote = raw?.trim();
  if (!remote || /[\s\\\x00-\x1f\x7f]/.test(remote) || /^[a-z]:/i.test(remote)) return null;
  let source = remote;
  if (!/^(https?|ssh):\/\//i.test(source)) {
    const scp = /^git@([^/:]+):(.+)$/.exec(source);
    if (!scp) return null;
    source = `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(source);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname) return null;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    const protocol = url.protocol === "ssh:" ? "https:" : url.protocol;
    return sanitizeRepoWebUrl(`${protocol}//${url.hostname}${path}`);
  } catch {
    return null;
  }
}
function readRepoUrl(directory, signal) {
  return new Promise((resolve, reject) => {
    execFile2(
      "git",
      ["-C", directory, "config", "--local", "--get", "remote.origin.url"],
      { windowsHide: true, timeout: 1500, signal },
      (error2, stdout) => {
        if (error2) reject(error2);
        else resolve(normalizeRepoUrl(stdout));
      }
    );
  }).catch((error2) => {
    if (error2?.name === "AbortError") throw error2;
    return null;
  });
}

// config/presence-format.json
var presence_format_default = {
  brand: "Orca",
  noAgentTitle: "",
  noAgentState: "",
  folderPrefix: "\u{1F4C1} ",
  separator: " \xB7 ",
  agentOne: "agent",
  agentMany: "agents",
  working: "Working",
  idle: "Idle",
  workspaceOne: "workspace",
  workspaceMany: "workspaces",
  privateProject: "Private Project",
  repositoryButton: "View Repository",
  branchFallback: "Branch"
};

// src/presence-format.ts
var FORMAT = presence_format_default;
var FIELD_LIMIT = 128;
var FOLDER_LIMIT = 100;
var FIELD_MIN = 2;
var graphemes = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
function clip(value, limit) {
  if (value.length <= limit) return value;
  let kept = "";
  for (const { segment } of graphemes.segment(value)) {
    if (kept.length + segment.length > limit) break;
    kept += segment;
  }
  return kept;
}
function field(value) {
  return value.length >= FIELD_MIN ? value : "";
}
function countOf(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function composeText(input) {
  if (input.agentName === null) {
    return { details: FORMAT.noAgentTitle, state: FORMAT.noAgentState, iconText: "" };
  }
  const count = countOf(input.runningAgentCount);
  const workspaces = countOf(input.activeWorkspaceCount);
  const status = input.agentActive === false ? FORMAT.idle : FORMAT.working;
  const agentCount = `${count} ${count === 1 ? FORMAT.agentOne : FORMAT.agentMany}`;
  const agentSuffix = `${FORMAT.separator}${agentCount}${FORMAT.separator}${status}`;
  const agent = field(clip(normalizeText(input.agentName), FIELD_LIMIT));
  const workspaceCount = `${workspaces} ${workspaces === 1 ? FORMAT.workspaceOne : FORMAT.workspaceMany}`;
  const folder = field(normalizeText(input.incognito ? FORMAT.privateProject : input.projectName));
  const workspaceSuffix = `${FORMAT.separator}${workspaceCount}`;
  const folderLine = folder ? clip(`${FORMAT.folderPrefix}${folder}`, Math.min(FOLDER_LIMIT, FIELD_LIMIT - workspaceSuffix.length)) : "";
  return {
    details: agent ? `${clip(agent, FIELD_LIMIT - agentSuffix.length)}${agentSuffix}` : "",
    state: folderLine ? `${folderLine}${workspaceSuffix}` : workspaceCount,
    iconText: field(clip(normalizeText(input.model), FIELD_LIMIT)) || agent
  };
}

// src/presence.ts
function buildActivity(input) {
  const registry = input.registry ?? builtinRegistry;
  const uploaded = input.useUploadedArt === true;
  const agent = input.agentType === null ? null : registry.resolve(input.agentType);
  const text = composeText({
    projectName: input.projectName,
    agentName: agent?.name ?? null,
    runningAgentCount: input.runningAgentCount,
    activeWorkspaceCount: input.activeWorkspaceCount,
    ...input.incognito !== void 0 ? { incognito: input.incognito } : {},
    ...input.agentActive !== void 0 ? { agentActive: input.agentActive } : {},
    ...input.model !== void 0 ? { model: input.model } : {}
  });
  if (agent === null) return { details: text.details, state: text.state, startTimestamp: input.startedAt };
  const branchText = clip(normalizeText(input.incognito ? null : input.branchName), FIELD_LIMIT) || FORMAT.branchFallback;
  const branchArt = uploaded ? { smallImageKey: registry.branchIcon.asset, smallImageText: branchText } : { smallImageUrl: registry.branchIcon.imageUrl, smallImageText: branchText };
  const image = (uploaded ? agent.asset : null) ?? agent.imageUrl;
  const agentArt = uploaded ? { largeImageKey: image ?? registry.fallbackIcon.asset, largeImageText: text.iconText } : image !== null ? { largeImageUrl: image, largeImageText: text.iconText } : { largeImageKey: registry.fallbackIcon.asset, largeImageText: text.iconText };
  return {
    details: text.details,
    state: text.state,
    startTimestamp: input.startedAt,
    ...agentArt,
    ...branchArt
  };
}

// src/presence-controller.ts
function createPresenceController(deps) {
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  let lastKey = null;
  let sessionStartedAt = null;
  let lastEpoch = deps.connectionEpoch?.() ?? 0;
  return {
    async poll() {
      const epoch = deps.connectionEpoch?.() ?? lastEpoch;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        lastKey = null;
      }
      let state;
      try {
        state = await deps.readState();
      } catch {
        return;
      }
      if (!state) {
        if (lastKey === "__none__") {
          return;
        }
        if (await deps.clear().catch(() => false)) {
          lastKey = "__none__";
          sessionStartedAt = null;
        }
        return;
      }
      const key = JSON.stringify({
        project: state.projectName,
        agent: state.agentType,
        model: state.model ?? null,
        count: state.runningAgentCount,
        workspaces: state.activeWorkspaceCount,
        active: state.agentActive !== false,
        branch: state.branchName,
        repo: state.repoUrl ?? null
      });
      if (key === lastKey) {
        return;
      }
      const startedAt = sessionStartedAt ?? now();
      const activity = (deps.buildActivity ?? buildActivity)({
        projectName: state.projectName,
        agentType: state.agentType,
        model: state.model ?? null,
        runningAgentCount: state.runningAgentCount,
        activeWorkspaceCount: state.activeWorkspaceCount,
        agentActive: state.agentActive,
        branchName: state.branchName,
        repoUrl: state.repoUrl ?? null,
        startedAt,
        ...deps.useUploadedArt !== void 0 ? { useUploadedArt: deps.useUploadedArt } : {}
      });
      if (await deps.apply(activity).catch(() => false)) {
        lastKey = key;
        sessionStartedAt = startedAt;
      }
    },
    reset(preserveSession = false) {
      lastKey = null;
      if (!preserveSession) sessionStartedAt = null;
    }
  };
}

// src/orca-gated-reader.ts
function createOrcaGatedStateReader(deps) {
  let lastKnown = null;
  return {
    async read() {
      const running = await deps.isOrcaRunning();
      if (running !== lastKnown) {
        lastKnown = running;
        deps.onTransition?.(running);
      }
      if (!running) {
        return null;
      }
      return deps.readState();
    },
    isOrcaRunning: () => lastKnown
  };
}

// src/orca-process.ts
function orcaProcessName(platform2) {
  if (platform2 === "win32") {
    return "Orca.exe";
  }
  return platform2 === "darwin" ? "Orca" : "orca";
}
function parseTasklist(output) {
  return /^\s*"?Orca\.exe"?\s*[, ]/im.test(output);
}
function parsePgrep(output) {
  return /^\s*\d+\s*$/m.test(output);
}
async function defaultExec(command, args) {
  const { execFile: execFile4 } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile4(
      command,
      [...args],
      { timeout: 5e3, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error2, stdout) => resolve({ stdout: stdout ?? "", failed: error2 !== null })
    );
  });
}
async function isOrcaRunning(options = {}) {
  const platform2 = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const name = orcaProcessName(platform2);
  const result = platform2 === "win32" ? await exec("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"]) : await exec("pgrep", ["-x", name]);
  if (result.failed) {
    return false;
  }
  return platform2 === "win32" ? parseTasklist(result.stdout) : parsePgrep(result.stdout);
}

// src/runtime.ts
function createPresenceRuntime(options) {
  const log = options.log ?? (() => {
  });
  const registry = options.registry ?? builtinRegistry;
  const discord = options.deps ? null : createDiscordPresence(options.clientId);
  const deps = options.deps ?? {
    isOrcaRunning,
    readState: () => readPresenceState(
      void 0,
      void 0,
      (agentType, path) => findAgentModel(agentType, path, void 0, registry)
    ),
    apply: (activity) => discord.apply(activity),
    clear: () => discord.clear(),
    connectionGeneration: () => discord.connectionGeneration(),
    schedule: (tick2, ms) => {
      const timer = setInterval(() => void tick2(), ms);
      return () => clearInterval(timer);
    }
  };
  let reader = null;
  let controller = null;
  let cancel = null;
  let started = false;
  let paused = false;
  let lastActivity = null;
  let lastPushAt = null;
  let lastError = null;
  const listeners = /* @__PURE__ */ new Set();
  const getStatus = () => ({
    // Why derived: with injected deps there is no socket, and a successful push is the
    // only connection signal those tests can offer.
    discordConnected: discord?.isConnected() ?? lastActivity !== null,
    orcaRunning: reader?.isOrcaRunning() ?? false,
    paused,
    lastActivity,
    lastPushAt,
    lastError
  });
  const notify = () => {
    const status = getStatus();
    for (const listener of listeners) {
      listener(status);
    }
  };
  const tick = async () => {
    if (!started || paused || !controller) {
      return;
    }
    try {
      await controller.poll();
    } catch (error2) {
      lastError = error2 instanceof Error ? error2.message : String(error2);
    }
    notify();
  };
  const ensureWired = () => {
    if (reader && controller) {
      return;
    }
    reader = createOrcaGatedStateReader({
      isOrcaRunning: deps.isOrcaRunning,
      readState: deps.readState,
      onTransition: (running) => log(running ? "Orca detected; reporting presence" : "Orca closed; clearing presence")
    });
    controller = createPresenceController({
      readState: () => reader.read(),
      apply: async (activity) => {
        const ok = await deps.apply(activity);
        if (ok) {
          lastActivity = activity;
          lastPushAt = Date.now();
          lastError = null;
          const art = activity.largeImageUrl ?? activity.largeImageKey;
          log(`pushed: ${activity.details} | ${activity.state}${art ? ` | art=${art}` : ""}`);
        } else {
          lastError = "Discord rejected or could not receive the activity";
          log(`push failed: ${activity.details}`);
        }
        return ok;
      },
      clear: () => deps.clear(),
      connectionEpoch: deps.connectionGeneration,
      useUploadedArt: options.useUploadedArt,
      buildActivity: options.buildActivity ?? ((input) => buildActivity({ ...input, registry }))
    });
  };
  return {
    async start(preserveSession = false) {
      ensureWired();
      if (started && !paused) {
        await tick();
        return;
      }
      controller?.reset(preserveSession);
      started = true;
      paused = false;
      cancel?.();
      cancel = deps.schedule(tick, options.pollMs);
      await tick();
    },
    async pause() {
      paused = true;
      cancel?.();
      cancel = null;
      const cleared = await deps.clear();
      notify();
      return cleared;
    },
    async stop() {
      started = false;
      paused = false;
      cancel?.();
      cancel = null;
      await discord?.destroy();
      notify();
    },
    getStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

// src/plugin-presence.ts
function buildPluginActivity(input) {
  const registry = input.registry ?? builtinRegistry;
  const uploaded = input.useUploadedArt === true;
  const agent = input.agentType === null ? null : registry.resolve(input.agentType);
  const text = composeText({
    projectName: input.projectName,
    agentName: agent?.name ?? null,
    runningAgentCount: input.runningAgentCount,
    activeWorkspaceCount: input.activeWorkspaceCount,
    ...input.incognito !== void 0 ? { incognito: input.incognito } : {},
    ...input.agentActive !== void 0 ? { agentActive: input.agentActive } : {},
    ...input.model !== void 0 ? { model: input.model } : {}
  });
  if (agent === null) return { details: text.details, state: text.state, startTimestamp: input.startedAt };
  const activity = {
    details: text.details,
    state: text.state,
    startTimestamp: input.startedAt,
    largeImageText: FORMAT.brand,
    ...uploaded ? { largeImageKey: registry.fallbackIcon.asset } : {}
  };
  if (uploaded && agent.asset) activity.smallImageKey = agent.asset;
  else if (agent.imageUrl) activity.smallImageUrl = agent.imageUrl;
  else if (uploaded) activity.smallImageKey = registry.fallbackIcon.asset;
  else activity.smallImageUrl = registry.fallbackIcon.imageUrl;
  activity.smallImageText = text.iconText;
  if (!input.incognito) {
    const repoUrl = sanitizeRepoWebUrl(input.repoUrl);
    if (repoUrl) activity.buttons = [{ label: FORMAT.repositoryButton, url: repoUrl }];
  }
  return activity;
}

// src/plugin-session.ts
function createPluginSession(options) {
  let enabled = options.enabled;
  let incognito = options.incognito;
  let privacyPending = false;
  let readError = null;
  let closed = false;
  let tail = Promise.resolve();
  let refreshJob = null;
  let shutdown = null;
  const report = (error2) => options.log(error2 instanceof Error ? error2.message : String(error2));
  const destroyTransport = async () => {
    try {
      await options.transport.destroy();
    } catch {
      const message = options.transport.lastError?.() ?? "Discord RPC destroy failed (code: unknown)";
      if (!closed) publish({ ...runtime.getStatus(), lastError: message });
      throw new Error(message);
    }
  };
  const serial = (operation) => {
    const job = tail.then(operation);
    tail = job.catch(report);
    return job;
  };
  const interval = options.scheduleInterval ?? ((tick, ms) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  });
  const refresh = () => {
    if (closed || !enabled) return Promise.resolve();
    if (refreshJob) return refreshJob;
    refreshJob = serial(async () => {
      if (!closed && enabled) await runtime.start();
    }).finally(() => {
      refreshJob = null;
    });
    return refreshJob;
  };
  const runtime = createPresenceRuntime({
    ...options.config,
    log: options.log,
    buildActivity: (input) => buildPluginActivity({ ...input, incognito, ...options.registry ? { registry: options.registry } : {} }),
    deps: {
      isOrcaRunning: async () => true,
      readState: async () => {
        try {
          const state = await options.readState();
          readError = null;
          return state && incognito ? { ...state, projectName: FORMAT.privateProject, branchName: null, repoUrl: null } : state;
        } catch (error2) {
          readError = error2 instanceof Error ? error2.message : String(error2);
          report(error2);
          throw error2;
        }
      },
      // Publication waits until the old activity is cleared or its socket is closed.
      apply: async (activity) => {
        if (closed || privacyPending) return false;
        const ok = await options.transport.apply(activity, () => !closed && !privacyPending);
        const error2 = options.transport.lastError?.();
        if (!ok && error2) options.log(error2);
        return ok;
      },
      clear: async () => {
        const ok = await options.transport.clear();
        const error2 = options.transport.lastError?.();
        if (!ok && error2) options.log(error2);
        return ok;
      },
      connectionGeneration: options.transport.connectionGeneration,
      schedule: (_tick, ms) => interval(() => {
        void refresh().catch(report);
      }, ms)
    }
  });
  const publish = (status) => options.onStatus({
    ...status,
    paused: !enabled,
    discordConnected: options.transport.isConnected(),
    lastError: readError ?? options.transport.lastError?.() ?? status.lastError
  });
  const unsubscribe = runtime.subscribe(publish);
  publish(runtime.getStatus());
  return {
    refresh,
    setEnabled: (value) => serial(async () => {
      if (closed || value === enabled) return;
      enabled = value;
      if (enabled) await runtime.start();
      else await runtime.pause();
    }),
    setIncognito: (value) => {
      if (closed || value === incognito) return Promise.resolve();
      incognito = value;
      privacyPending = true;
      return serial(async () => {
        if (!closed) {
          const cleared = await runtime.pause().catch((error2) => {
            report(error2);
            return false;
          });
          if (!cleared) await destroyTransport();
        }
        privacyPending = false;
        if (!closed && enabled) await runtime.start(true);
      });
    },
    stop: () => {
      if (shutdown) return shutdown;
      closed = true;
      shutdown = serial(async () => {
        unsubscribe();
        try {
          await runtime.stop();
        } finally {
          try {
            await options.transport.clear();
          } finally {
            await destroyTransport();
          }
        }
      });
      return shutdown;
    }
  };
}

// src/update.ts
import { execFile as execFile3 } from "node:child_process";
import { homedir as homedir4 } from "node:os";
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile3(command, args, {
      ...options,
      encoding: "utf8",
      timeout: 12e4,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error2, stdout) => resolve({ error: error2, stdout }));
  });
}
async function updateInstalledPlugin(command, nodeEntry) {
  const pluginKey = "meryzennn.discord-presence";
  const { error: error2, stdout } = await run(command, [nodeEntry, "plugin", "update", pluginKey, "--json"], {
    env: pluginCliEnv(process.env, process.platform, homedir4())
  });
  const unconfirmed = "Could not confirm the RPC update. Check Orca Settings > Plugins.";
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error(unconfirmed);
  }
  if (!isRecord(response)) throw new Error(unconfirmed);
  if (response.ok !== true) {
    const failure = isRecord(response.error) ? response.error : {};
    if (failure.code === "invalid_argument" && typeof failure.message === "string" && failure.message.startsWith("Unknown command: plugin update")) {
      throw new Error("Updating requires Orca 1.4.253 or newer. Upgrade the Orca application first.");
    }
    if (failure.code === "approval_required" || failure.code === "approval_stale") {
      throw new Error("This update needs review in Orca Settings > Plugins. The current version stays installed.");
    }
    if (failure.code === "plugin_not_found") {
      throw new Error("No Git installation of Discord RPC was found. Install it through Orca Settings > Plugins first.");
    }
    if (failure.code === "git_auth_failed") {
      throw new Error("Git authentication failed. Check the Orca host's Git sign-in and retry.");
    }
    throw new Error(unconfirmed);
  }
  const result = response.result;
  if (error2 || !isRecord(result) || result.pluginKey !== pluginKey || result.status !== "updated" && result.status !== "up-to-date" && result.status !== "pinned" || typeof result.version !== "string" || result.version.length > 80 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(result.version)) {
    throw new Error(unconfirmed);
  }
  return { status: result.status, version: result.version };
}

// src/orca-plugin.ts
function createPluginLifecycle(orca, legacy, startSession, updatePlugin = () => updateInstalledPlugin(
  process.execPath,
  resolveBundledCliEntry(process.execPath, process.platform)
)) {
  const readerAbort = new AbortController();
  const report = (error2) => orca.log(error2 instanceof Error ? error2.message : String(error2));
  let session = null;
  const subscriptions = [];
  let stopping = false;
  let starting = null;
  let shutdown = null;
  let settingsWork = Promise.resolve(void 0);
  let updateWork = null;
  const queueSetting = (operation) => {
    const job = settingsWork.then(async () => {
      if (!stopping) return operation();
    });
    settingsWork = job.catch(report);
    return job;
  };
  const toggleSetting = (key) => queueSetting(async () => {
    const value = await orca.settings.get(key);
    if (stopping) return;
    if (typeof value !== "boolean" && (key === "incognito" || value != null)) {
      throw new Error(`${key} setting must be boolean`);
    }
    return orca.settings.set(key, value === false);
  });
  const updateIncognito = (value) => {
    if (stopping) return;
    void orca.host.call("statusBar.update", {
      id: "incognito",
      text: value ? "Incognito On" : "Incognito Off",
      tooltip: value ? "Incognito on: project and repository hidden. Click to turn off." : "Incognito off: click to hide project and repository."
    }).catch(report);
  };
  const requestUpdate = async () => {
    if (stopping) return;
    if (updateWork) return "An RPC update is already running. See Logs below.";
    orca.log("Checking for RPC updates.");
    updateWork = Promise.resolve().then(updatePlugin).then((result) => {
      if (stopping) return;
      const message = result.status === "updated" ? "Updated RPC to version " + result.version + "." : result.status === "up-to-date" ? "RPC is up to date (version " + result.version + ")." : "RPC version " + result.version + " is pinned. Install a version tag or branch to follow updates.";
      orca.log(message);
    }).catch((error2) => {
      if (!stopping) report(error2);
    }).finally(() => {
      updateWork = null;
    });
    return "Checking for RPC updates. See Logs below.";
  };
  const deactivate2 = () => {
    if (shutdown) return shutdown;
    stopping = true;
    readerAbort.abort();
    const current = session;
    session = null;
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch (error2) {
        report(error2);
      }
    }
    shutdown = current?.stop() ?? Promise.resolve();
    return shutdown;
  };
  return {
    activate: () => {
      if (starting) return starting;
      if (stopping) return Promise.resolve();
      starting = (async () => {
        let incognito = await orca.settings.get("incognito");
        if (stopping) return;
        if (incognito == null) {
          const migrated = legacy?.incognito === true;
          incognito = migrated;
          await orca.settings.set("incognito", migrated);
          if (stopping) return;
        }
        if (typeof incognito !== "boolean") throw new Error("Incognito setting must be boolean");
        const enabled = await orca.settings.get("enabled");
        if (stopping) return;
        if (enabled != null && typeof enabled !== "boolean") throw new Error("Enabled setting must be boolean");
        const current = startSession(enabled !== false, incognito, readerAbort.signal, (status) => {
          if (stopping) return;
          const text = status.paused ? "RPC paused" : status.discordConnected ? "RPC" : "RPC waiting";
          const tooltip = status.paused ? "Discord Rich Presence paused: click to resume" : status.lastError ?? "Discord Rich Presence: click to pause or resume";
          void orca.host.call("statusBar.update", {
            id: "presence",
            text,
            tooltip
          }).catch(report);
        });
        session = current;
        updateIncognito(incognito);
        const refresh = () => {
          if (!stopping) void current.refresh().catch(report);
        };
        subscriptions.push(orca.commands.register("presence.toggle", () => toggleSetting("enabled")));
        subscriptions.push(orca.commands.register("presence.incognito.toggle", () => toggleSetting("incognito")));
        subscriptions.push(orca.commands.register("presence.update", requestUpdate));
        subscriptions.push(orca.events.on("workspace.changed", refresh));
        subscriptions.push(orca.events.on("agent.status.changed", refresh));
        subscriptions.push(orca.settings.onDidChange(({ key }) => {
          if (key !== "enabled" && key !== "incognito") return;
          void queueSetting(async () => {
            const value = await orca.settings.get(key);
            if (stopping) return;
            if (typeof value !== "boolean") throw new Error(`${key} setting must be boolean`);
            void (key === "enabled" ? current.setEnabled(value) : current.setIncognito(value)).catch(report);
            if (key === "incognito") updateIncognito(value);
          });
        }));
        refresh();
      })().catch(async (error2) => {
        await deactivate2().catch(report);
        throw error2;
      });
      return starting;
    },
    deactivate: deactivate2
  };
}
var lifecycle = null;
async function activate(orca) {
  const log = (message) => orca.log(message);
  const legacy = readConfigFile(configPath(), log);
  const config = loadConfig({ env: {}, readConfigFile: () => legacy });
  const registry = createAgentRegistry({ overrides: config.agents, log });
  const cliEntry = resolveBundledCliEntry(process.execPath, process.platform);
  const uid = process.getuid?.();
  const runtimeDirectory = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR || (uid === void 0 ? void 0 : `/run/user/${uid}`) : void 0;
  const paths = pluginDiscordPaths(process.platform, tmpdir2(), runtimeDirectory);
  const current = createPluginLifecycle(orca, legacy, (enabled, incognito, signal, onStatus) => createPluginSession({
    config,
    registry,
    enabled,
    incognito,
    onStatus,
    log,
    readState: () => readPresenceState(
      () => runOrcaWorktreePs(process.execPath, cliEntry, signal),
      (path) => readRepoUrl(path, signal),
      (agentType, path) => findAgentModel(agentType, path, void 0, registry)
    ),
    transport: createDiscordPresence(config.clientId, (clientId) => createDiscordIpcClient(clientId, paths))
  }), () => updateInstalledPlugin(process.execPath, cliEntry));
  lifecycle = current;
  await current.activate();
}
async function deactivate() {
  const current = lifecycle;
  lifecycle = null;
  await current?.deactivate();
}
export {
  createPluginLifecycle,
  deactivate,
  activate as default
};
