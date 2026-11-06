// src/orca-plugin.ts
import { readFileSync as readFileSync2 } from "node:fs";
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
  const start = input.startTimestamp.getTime();
  return {
    type: 0,
    created_at: Date.now(),
    instance: false,
    ...input.details ? { details: input.details } : {},
    ...input.state ? { state: input.state } : {},
    ...Number.isFinite(start) ? { timestamps: { start } } : {},
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
      const body = Buffer.from(JSON.stringify(payload));
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

// src/config.ts
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
  return { clientId, pollMs: readPollMs(file?.pollMs), useUploadedArt };
}

// src/paths.ts
import { join } from "node:path";
import { homedir, platform } from "node:os";
function appDir() {
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "orca-discord-rpc");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "orca-discord-rpc");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "orca-discord-rpc");
}
var configPath = () => join(appDir(), "config.json");

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
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function parseWorktreePs(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) {
    return [];
  }
  const worktrees = parsed.result.worktrees;
  if (!Array.isArray(worktrees)) {
    return [];
  }
  return worktrees.filter(isRecord).map((worktree) => ({
    ...worktree,
    agents: Array.isArray(worktree.agents) ? worktree.agents.filter(isRecord) : []
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
function hasActiveAgent(worktree) {
  return liveAgents(worktree).length > 0;
}
function openAgents(worktree) {
  return allAgents(worktree);
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
function runningAgentCount(worktree) {
  return openAgents(worktree).length;
}

// src/agent-model.ts
import { closeSync, existsSync as existsSync2, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var TAIL_BYTES = 64 * 1024;
var MODEL_OVERLAP_BYTES = 1024;
var HEAD_BYTES = 16 * 1024;
var SESSIONS_SCANNED = 50;
var MODEL_FIELD = /"model":"([^"]+)"/g;
var CWD_FIELD = /"cwd":("(?:[^"\\]|\\.)*")/;
var IS_WINDOWS = process.platform === "win32";
var defaultSources = { env: (name) => process.env[name], home: homedir2() };
function findAgentModel(agentType, worktreePath, sources = defaultSources) {
  if (!agentType || !worktreePath) {
    return null;
  }
  try {
    let log;
    if (agentType === "claude" || agentType === "claude-agent-teams") {
      log = newestClaudeSession(nonEmpty(sources.env("CLAUDE_CONFIG_DIR")) ?? join2(sources.home, ".claude"), worktreePath);
    } else if (agentType === "codex") {
      const codexHome = nonEmpty(sources.env("CODEX_HOME")) ?? join2(sources.home, ".codex");
      log = newestWorkspaceSession(join2(codexHome, "sessions"), worktreePath, "codex");
    } else if (agentType === "omp") {
      const agentDir = nonEmpty(sources.env("PI_CODING_AGENT_DIR")) ?? join2(sources.home, ".omp", "agent");
      log = newestWorkspaceSession(join2(agentDir, "sessions"), worktreePath, "omp");
    } else if (agentType === "antigravity" || agentType === "agy") {
      const agyHome = nonEmpty(sources.env("ANTIGRAVITY_HOME")) ?? join2(sources.home, ".gemini", "antigravity-cli");
      const raw2 = newestAntigravityModel(agyHome, worktreePath);
      return raw2 === null ? null : prettyModelName(raw2);
    } else {
      return null;
    }
    const raw = log === null ? null : readLastModel(log, agentType === "omp" ? lastOmpModelIn : lastModelIn);
    return raw === null ? null : prettyModelName(raw);
  } catch {
    return null;
  }
}
function claudeProjectSlug(path) {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
function lastModelIn(text2) {
  let last = null;
  for (const match of text2.matchAll(MODEL_FIELD)) {
    const value = match[1] ?? "";
    if (!value.startsWith("<")) {
      last = value;
    }
  }
  return last;
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
function nonEmpty(value) {
  return value !== void 0 && value.trim().length > 0 ? value : void 0;
}
function samePath(a, b) {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
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
function newestClaudeSession(claudeHome, worktreePath) {
  const projects = join2(claudeHome, "projects");
  if (!existsSync2(projects)) {
    return null;
  }
  const slug = claudeProjectSlug(worktreePath.replace(/[/\\]+$/, ""));
  const files = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && samePath(entry.name, slug)).flatMap(
    (entry) => readdirSync(join2(projects, entry.name)).filter((name) => name.endsWith(".jsonl")).map((name) => join2(projects, entry.name, name))
  );
  return newestOf(files);
}
function newestWorkspaceSession(sessions, worktreePath, layout) {
  if (!existsSync2(sessions)) {
    return null;
  }
  const wanted = normalizePath(worktreePath);
  const names = layout === "codex" ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) => basename(name).startsWith("rollout-") && name.endsWith(".jsonl")) : readdirSync(sessions, { withFileTypes: true }).flatMap((bucket) => bucket.isDirectory() ? readdirSync(join2(sessions, bucket.name), { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith(".jsonl")).map((file) => join2(bucket.name, file.name)) : []);
  const recent = names.map((name) => {
    const file = join2(sessions, name);
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
function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
function lastOmpModelIn(text2) {
  let last = null;
  for (const line of text2.split("\n")) {
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
function lastAntigravityModelIn(text2) {
  const regex = /`Model Selection` (?:from [^\n`]+ )?to ([^\n`]+?)(?:\.\s|\.\n|\.\\n|\.?<\/|\.?$)/g;
  let last = null;
  for (const match of text2.matchAll(regex)) {
    let val = match[1]?.trim();
    if (val) {
      val = val.replace(/\.?(\\n|\n)?$/, "").replace(/\.$/, "").trim();
      if (val && !val.startsWith("<")) last = val;
    }
  }
  return last;
}
function defaultAntigravityModel(agyHome) {
  for (const dir of [agyHome, join2(agyHome, "..")]) {
    const settings = join2(dir, "settings.json");
    if (!existsSync2(settings)) continue;
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
  if (!existsSync2(history)) return null;
  const wanted = normalizePath(worktreePath);
  const fd = openSync(history, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    let position = Math.max(0, size - buffer.length);
    while (position >= 0) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
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
    closeSync(fd);
  }
  return null;
}
function newestAntigravityModel(agyHome, worktreePath) {
  if (!existsSync2(agyHome)) return null;
  const conversationId = newestAntigravityConversation(agyHome, worktreePath);
  if (conversationId) {
    const transcript = join2(agyHome, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync2(transcript)) {
      const fromTranscript = readLastModel(transcript, lastAntigravityModelIn);
      if (fromTranscript) return fromTranscript;
    }
  }
  return defaultAntigravityModel(agyHome);
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
async function readPresenceState(runWorktreePs = runOrcaWorktreePs, resolveRepoUrl) {
  const worktrees = parseWorktreePs(await runWorktreePs());
  const active = selectActiveWorktree(worktrees);
  if (!active) {
    return null;
  }
  const featured = featuredAgent(active);
  const agentType = typeof featured?.agentType === "string" ? featured.agentType : null;
  return {
    projectName: projectNameFor(active),
    // Why the agent type and not a label: the builder owns naming and art for it.
    agentType,
    model: findAgentModel(agentType, typeof active.path === "string" ? active.path : null),
    runningAgentCount: runningAgentCount(active),
    agentActive: hasActiveAgent(active),
    branchName: branchNameFor(active),
    ...resolveRepoUrl ? { repoUrl: typeof active.path === "string" && active.path.length > 0 ? await resolveRepoUrl(active.path) : null } : {}
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

// src/agent-art.ts
var BRANCH_ART_KEY = "git-branch";
var AGENT_ART_KEYS = {
  claude: "claude",
  "claude-agent-teams": "claude",
  codex: "codex",
  opencode: "opencode",
  opencode2: "opencode",
  omp: "omp",
  "command-code": "commandcode",
  dsh: "deepsek-harnnes",
  grok: "grock",
  hermes: "hermes",
  antigravity: "agy",
  agy: "agy"
};
var AGENT_ICON_DOMAINS = {
  claude: "claude.ai",
  "claude-agent-teams": "claude.ai",
  codex: "openai.com",
  opencode: "opencode.ai",
  opencode2: "opencode.ai",
  "command-code": "commandcode.ai",
  dsh: "deepseek.com",
  grok: "x.ai",
  hermes: "hermes.nousresearch.com",
  antigravity: "antigravity.google",
  agy: "antigravity.google",
  cursor: "cursor.com",
  gemini: "gemini.google.com",
  copilot: "github.com",
  amp: "ampcode.com",
  aider: "aider.chat",
  goose: "block.github.io",
  devin: "devin.ai",
  kimi: "kimi.moonshot.cn"
};
var FAVICON = (domain, size) => `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
var BRANCH_ICON_URL = FAVICON("git-scm.com", 128);
function agentArtKey(agentType) {
  return AGENT_ART_KEYS[agentType] ?? null;
}
function agentFaviconUrl(agentType) {
  if (agentType === "omp") {
    return "https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png";
  }
  const domain = AGENT_ICON_DOMAINS[agentType];
  return domain ? FAVICON(domain, 256) : null;
}

// src/presence.ts
var PRESENCE_ASSET_KEY = "orca";
var KNOWN_AGENT_LABELS = {
  "claude-agent-teams": "Claude",
  opencode: "OpenCode",
  opencode2: "OpenCode",
  omp: "Oh My Pi",
  "qwen-code": "Qwen Code"
};
var FIELD_LIMIT = 128;
var PROJECT_LIMIT = 100;
var FIELD_MIN = 2;
function field(value) {
  return value.length >= FIELD_MIN ? value : "";
}
function normalizeName(value) {
  return value.replace(/\s+/g, " ").trim();
}
function agentDisplayName(agentType) {
  const known = KNOWN_AGENT_LABELS[agentType];
  if (known) {
    return known;
  }
  return agentType.split(/[-_\s]+/).filter((part) => part.length > 0).map((part) => (part[0] ?? "").toUpperCase() + part.slice(1)).join(" ");
}
function agentImageUrl(agentType, useUploadedArt) {
  if (useUploadedArt) {
    const key = agentArtKey(agentType);
    if (key !== null) {
      return key;
    }
  }
  return agentFaviconUrl(agentType);
}
function buildActivity(input) {
  const project = field(
    input.projectName ? normalizeName(input.projectName).slice(0, PROJECT_LIMIT) : ""
  );
  const count = Math.max(0, Math.trunc(input.runningAgentCount));
  const uploaded = input.useUploadedArt === true;
  const branchText = input.branchName ? normalizeName(input.branchName).slice(0, 128) : "Branch";
  const branchArt = uploaded ? { smallImageKey: BRANCH_ART_KEY, smallImageText: branchText } : { smallImageUrl: BRANCH_ICON_URL, smallImageText: branchText };
  if (input.agentType === null) {
    const state = composeStateLine(project, count);
    return {
      details: "Using Orca",
      // Why a fallback: an empty state simply hides line 2, which beats a rejected update.
      state: state.length >= FIELD_MIN ? state : "Orca",
      startTimestamp: input.startedAt,
      largeImageKey: PRESENCE_ASSET_KEY,
      largeImageText: "Orca",
      ...branchArt
    };
  }
  const agent = agentDisplayName(input.agentType);
  const image = agentImageUrl(input.agentType, uploaded);
  const iconText = field(input.model?.slice(0, FIELD_LIMIT) ?? "") || "Agent";
  const agentArt = uploaded ? { largeImageKey: image ?? PRESENCE_ASSET_KEY, largeImageText: iconText } : image !== null ? { largeImageUrl: image, largeImageText: iconText } : { largeImageKey: PRESENCE_ASSET_KEY, largeImageText: iconText };
  return {
    details: field(withOtherAgents(agent, input.runningAgentCount)),
    // Why the status and not a count: "+N" on line 1 already says how many agents are open.
    state: composeAgentStateLine(project, input.agentActive !== false),
    startTimestamp: input.startedAt,
    ...agentArt,
    ...branchArt
  };
}
function withOtherAgents(agent, runningAgentCount2) {
  const others = Math.max(0, Math.trunc(runningAgentCount2)) - 1;
  return others > 0 ? `${agent} +${others}` : agent;
}
function composeAgentStateLine(project, active) {
  const status = active ? "Working" : "Idle";
  if (project.length === 0) {
    return status;
  }
  const suffix = ` \xB7 ${status}`;
  const room = Math.max(0, FIELD_LIMIT - suffix.length);
  return `${project.slice(0, room)}${suffix}`;
}
function composeStateLine(project, count) {
  const suffix = count > 1 ? ` \xB7 ${count} agents` : "";
  if (project.length === 0) {
    return count > 1 ? `${count} agents` : "";
  }
  const room = Math.max(0, FIELD_LIMIT - suffix.length);
  return `${project.slice(0, room)}${suffix}`;
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
        active: state.agentActive,
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
  const { execFile: execFile3 } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile3(
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
  const discord = options.deps ? null : createDiscordPresence(options.clientId);
  const deps = options.deps ?? {
    isOrcaRunning,
    readState: readPresenceState,
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
          const art = activity.largeImageUrl ?? activity.largeImageKey ?? "none";
          log(`pushed: ${activity.details} | ${activity.state} | art=${art}`);
        } else {
          lastError = "Discord rejected or could not receive the activity";
          log(`push failed: ${activity.details}`);
        }
        return ok;
      },
      clear: () => deps.clear(),
      connectionEpoch: deps.connectionGeneration,
      useUploadedArt: options.useUploadedArt,
      buildActivity: options.buildActivity
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
function truncate(value, limit) {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}
function text(value, limit = 128) {
  const normalized = truncate(value?.replace(/\s+/g, " ").trim() ?? "", limit);
  return normalized.length >= 2 ? normalized : "";
}
function buildPluginActivity(input) {
  const uploaded = input.useUploadedArt === true;
  const folder = text(input.incognito ? "Private Project" : input.projectName);
  const project = folder ? truncate(/^folder:/i.test(folder) ? folder : `Folder: ${folder}`, 100) : "";
  const count = Number.isFinite(input.runningAgentCount) ? Math.max(0, Math.trunc(input.runningAgentCount)) : 0;
  const status = input.agentActive === false ? "Idle" : "Working";
  const activity = {
    details: "Using Orca",
    state: project || "Orca",
    startTimestamp: input.startedAt,
    largeImageText: "Orca",
    ...uploaded ? { largeImageKey: PRESENCE_ASSET_KEY } : {}
  };
  if (input.agentType !== null) {
    const agent = text(agentDisplayName(input.agentType));
    const suffix = `${count > 1 ? ` +${count - 1}` : ""} \xB7 ${status}`;
    activity.details = agent ? `Agent: ${truncate(agent, 128 - 7 - suffix.length)}${suffix}` : "";
    activity.state = project || status;
    const key = uploaded ? agentArtKey(input.agentType) : null;
    const url = key ? null : agentFaviconUrl(input.agentType);
    if (key || url) {
      if (key) activity.smallImageKey = key;
      else if (url) activity.smallImageUrl = url;
      activity.smallImageText = text(input.model) || text(`Agent: ${agent}`);
    }
  } else if (count > 1) {
    activity.state = project ? text(`${project} \xB7 ${count} agents`) : `${count} agents`;
  }
  if (!input.incognito) {
    const repoUrl = sanitizeRepoWebUrl(input.repoUrl);
    if (repoUrl) activity.buttons = [{ label: "View Repository", url: repoUrl }];
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
    buildActivity: (input) => buildPluginActivity({ ...input, incognito }),
    deps: {
      isOrcaRunning: async () => true,
      readState: async () => {
        try {
          const state = await options.readState();
          readError = null;
          return state && incognito ? { ...state, projectName: "Private Project", branchName: null, repoUrl: null } : state;
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

// src/orca-plugin.ts
function readLegacyConfig(path) {
  try {
    const value = JSON.parse(readFileSync2(path, "utf8").replace(/^\uFEFF/, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function createPluginLifecycle(orca, legacy, startSession) {
  const readerAbort = new AbortController();
  const report = (error2) => orca.log(error2 instanceof Error ? error2.message : String(error2));
  let session = null;
  const subscriptions = [];
  let stopping = false;
  let starting = null;
  let shutdown = null;
  let settingsWork = Promise.resolve(void 0);
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
          const text2 = status.paused ? "RPC paused" : status.discordConnected ? "RPC" : "RPC waiting";
          const tooltip = status.paused ? "Discord Rich Presence paused: click to resume" : status.lastError ?? "Discord Rich Presence: click to pause or resume";
          void orca.host.call("statusBar.update", {
            id: "presence",
            text: text2,
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
  const legacy = readLegacyConfig(configPath());
  const config = loadConfig({ env: {}, readConfigFile: () => legacy });
  const cliEntry = resolveBundledCliEntry(process.execPath, process.platform);
  const uid = process.getuid?.();
  const runtimeDirectory = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR || (uid === void 0 ? void 0 : `/run/user/${uid}`) : void 0;
  const paths = pluginDiscordPaths(process.platform, tmpdir2(), runtimeDirectory);
  const current = createPluginLifecycle(orca, legacy, (enabled, incognito, signal, onStatus) => createPluginSession({
    config,
    enabled,
    incognito,
    onStatus,
    log: (message) => orca.log(message),
    readState: () => readPresenceState(
      () => runOrcaWorktreePs(process.execPath, cliEntry, signal),
      (path) => readRepoUrl(path, signal)
    ),
    transport: createDiscordPresence(config.clientId, (clientId) => createDiscordIpcClient(clientId, paths))
  }));
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
  activate as default,
  readLegacyConfig
};
