const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { cert, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");
const multer = require("multer");
const { WebSocketServer, WebSocket } = require("ws");

function readJsonEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`);
  }
}

const serviceAccount = readJsonEnvironment("FIREBASE_SERVICE_KEY_JSON");
const firebaseWebConfig = readJsonEnvironment("FIREBASE_WEB_CONFIG_JSON");
const adminUid = process.env.ADMIN_UID;

if (!firebaseWebConfig || typeof firebaseWebConfig !== "object" || Array.isArray(firebaseWebConfig)) {
  throw new Error("FIREBASE_WEB_CONFIG_JSON must contain a JSON object");
}

if (!adminUid) {
  throw new Error("Missing required environment variable: ADMIN_UID");
}

for (const key of ["apiKey", "authDomain", "projectId", "appId"]) {
  if (typeof firebaseWebConfig[key] !== "string" || !firebaseWebConfig[key]) {
    throw new Error(`FIREBASE_WEB_CONFIG_JSON must include "${key}"`);
  }
}

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: "afterburn-radio.firebasestorage.app",
});

const auth = getAuth(firebaseApp);
const bucket = getStorage(firebaseApp).bucket();
const stateFile = bucket.file("radio-state.json");
const app = express();
const server = http.createServer(app);
const liveWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

let songLibrary = [];
let playlistQueue = [];
let activeListeners = new Set();
let currentStreamMode = "AUTODJ";
let liveBroadcastSocket = null;
let stateWrite = Promise.resolve();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

function getSongById(id) {
  return songLibrary.find((song) => song.id === id) || null;
}

function resolveQueueIds(ids) {
  return ids.map(getSongById).filter(Boolean);
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function validText(value, field, maxLength = 150) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    const error = new Error(`${field} must be between 1 and ${maxLength} characters`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

function saveRadioState() {
  const snapshot = JSON.stringify({ songLibrary, playlistQueue });
  const write = stateWrite
    .catch((error) => {
      console.error("Previous radio-state save failed:", error);
    })
    .then(() =>
      stateFile.save(snapshot, {
        resumable: false,
        metadata: { contentType: "application/json" },
      }),
    );

  stateWrite = write;
  return write;
}

async function loadRadioState() {
  const [stateExists] = await stateFile.exists();

  if (stateExists) {
    const [contents] = await stateFile.download();
    let savedState;
    try {
      savedState = JSON.parse(contents.toString("utf8"));
    } catch (error) {
      throw new Error(`Could not parse radio-state.json: ${error.message}`);
    }

    if (!Array.isArray(savedState.songLibrary) || !Array.isArray(savedState.playlistQueue)) {
      throw new Error("radio-state.json has an invalid format");
    }

    songLibrary = savedState.songLibrary.filter(
      (song) =>
        song &&
        typeof song.id === "string" &&
        typeof song.title === "string" &&
        typeof song.author === "string" &&
        typeof song.filePath === "string" &&
        song.filePath.startsWith("tracks/"),
    );

    const songIds = new Set(songLibrary.map((song) => song.id));
    playlistQueue = savedState.playlistQueue.filter(
      (id) => typeof id === "string" && songIds.has(id),
    );

    const availableSongs = [];
    for (const song of songLibrary) {
      const [exists] = await bucket.file(song.filePath).exists();
      if (exists) availableSongs.push(song);
    }
    songLibrary = availableSongs;
    const availableIds = new Set(songLibrary.map((song) => song.id));
    playlistQueue = playlistQueue.filter((id) => availableIds.has(id));
    return;
  }

  const [files] = await bucket.getFiles({ prefix: "tracks/" });
  for (const file of files) {
    const [metadata] = await file.getMetadata();
    const custom = metadata.metadata || {};
    const fileBase = path.posix.basename(file.name);
    const legacyId = fileBase.split("_")[0].split(".")[0];
    songLibrary.push({
      id: custom.songId || legacyId,
      title: custom.title || fileBase.replace(/^[^_]+_/, "").replace(/\.mp3$/i, ""),
      author: custom.author || "Unknown Artist",
      filePath: file.name,
      createdAt: custom.createdAt || metadata.timeCreated || new Date().toISOString(),
    });
  }

  playlistQueue = songLibrary.map((song) => song.id);
  if (songLibrary.length > 0) await saveRadioState();
}

async function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) {
    return res.status(401).json({ error: "Sign in with an authorized admin account" });
  }

  try {
    const decoded = await auth.verifyIdToken(match[1], true);
    if (decoded.uid !== adminUid) {
      return res.status(403).json({ error: "This account is not authorized to administer the station" });
    }
    next();
  } catch (error) {
    console.warn("Admin token verification failed:", error.message);
    res.status(401).json({ error: "Your sign-in has expired; sign in again" });
  }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/styles.css", (req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/admin.css", (req, res) => res.sendFile(path.join(__dirname, "admin.css")));
app.get("/admin.js", (req, res) => res.sendFile(path.join(__dirname, "admin.js")));
app.get("/Hitchman-Regular.ttf", (req, res) =>
  res.sendFile(path.join(__dirname, "Hitchman-Regular.ttf")),
);
app.get("/vendor/lame.min.js", (req, res) => {
  const lamePath = require.resolve("lamejs/lame.min.js");
  res.sendFile(lamePath);
});

app.get("/api/config", (req, res) => {
  res.json({
    apiKey: firebaseWebConfig.apiKey,
    authDomain: firebaseWebConfig.authDomain,
    projectId: firebaseWebConfig.projectId,
    appId: firebaseWebConfig.appId,
    ...(firebaseWebConfig.storageBucket
      ? { storageBucket: firebaseWebConfig.storageBucket }
      : {}),
  });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
  res.json({ authorized: true });
});

app.post(
  "/api/songs",
  requireAdmin,
  upload.single("audio"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Choose an MP3 file to upload" });
    }

    if (
      path.extname(req.file.originalname).toLowerCase() !== ".mp3" ||
      !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(req.file.mimetype)
    ) {
      return res.status(400).json({ error: "Only MP3 audio files are supported" });
    }

    const title = validText(req.body.title, "Title");
    const author = validText(req.body.author, "Artist");
    const id = crypto.randomUUID();
    const filePath = `tracks/${id}.mp3`;
    const createdAt = new Date().toISOString();
    const fileRef = bucket.file(filePath);

    await fileRef.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: "audio/mpeg",
        metadata: { songId: id, title, author, createdAt },
      },
    });

    const song = { id, title, author, filePath, createdAt };
    songLibrary.push(song);
    playlistQueue.push(id);

    try {
      await saveRadioState();
    } catch (error) {
      songLibrary = songLibrary.filter((item) => item.id !== id);
      playlistQueue = playlistQueue.filter((songId) => songId !== id);
      try {
        await fileRef.delete({ ignoreNotFound: true });
      } catch (cleanupError) {
        console.error(`Could not clean up failed upload ${filePath}:`, cleanupError.message);
      }
      throw error;
    }

    res.status(201).json({ message: "Song added successfully", song });
  }),
);

app.get("/api/songs", (req, res) => res.json(songLibrary));

app.get("/api/songs/:id", (req, res) => {
  const song = getSongById(req.params.id);
  if (!song) return res.status(404).json({ error: "Song not found" });
  res.json(song);
});

app.put(
  "/api/songs/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const song = getSongById(req.params.id);
    if (!song) return res.status(404).json({ error: "Song not found" });
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Provide a JSON object with a title or artist" });
    }

    const hasTitle = Object.hasOwn(req.body, "title");
    const hasAuthor = Object.hasOwn(req.body, "author");
    if (!hasTitle && !hasAuthor) {
      return res.status(400).json({ error: "Provide a title or artist to update" });
    }

    const previousSong = { ...song };
    if (hasTitle) song.title = validText(req.body.title, "Title");
    if (hasAuthor) song.author = validText(req.body.author, "Artist");
    if (song.title === previousSong.title && song.author === previousSong.author) {
      return res.json({ message: "Song is already up to date", song });
    }

    try {
      await bucket.file(song.filePath).setMetadata({
        metadata: { songId: song.id, title: song.title, author: song.author, createdAt: song.createdAt },
      });
      await saveRadioState();
    } catch (error) {
      Object.assign(song, previousSong);
      throw error;
    }

    res.json({ message: "Song updated successfully", song });
  }),
);

app.delete(
  "/api/songs/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const songIndex = songLibrary.findIndex((song) => song.id === req.params.id);
    if (songIndex === -1) return res.status(404).json({ error: "Song not found" });

    const song = songLibrary[songIndex];
    const previousSongs = songLibrary;
    const previousQueue = playlistQueue;
    songLibrary = songLibrary.filter((item) => item.id !== song.id);
    playlistQueue = playlistQueue.filter((id) => id !== song.id);

    try {
      await saveRadioState();
    } catch (error) {
      songLibrary = previousSongs;
      playlistQueue = previousQueue;
      throw error;
    }

    try {
      await bucket.file(song.filePath).delete({ ignoreNotFound: true });
    } catch (error) {
      songLibrary = previousSongs;
      playlistQueue = previousQueue;
      try {
        await saveRadioState();
      } catch (restoreError) {
        console.error(`Could not restore radio state after failed deletion of ${song.filePath}:`, restoreError.message);
      }
      throw error;
    }

    res.json({ message: "Song deleted successfully" });
  }),
);

app.get("/api/queue", (req, res) => res.json(resolveQueueIds(playlistQueue)));
app.get("/api/queue/ids", (req, res) => res.json(playlistQueue));

app.put(
  "/api/queue",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const newQueueIds = req.body?.newQueueIds;
    if (
      !Array.isArray(newQueueIds) ||
      newQueueIds.some((id) => typeof id !== "string" || !getSongById(id)) ||
      new Set(newQueueIds).size !== newQueueIds.length
    ) {
      return res.status(400).json({ error: "Queue must contain unique IDs for songs in the library" });
    }

    const previousQueue = playlistQueue;
    playlistQueue = newQueueIds;
    try {
      await saveRadioState();
    } catch (error) {
      playlistQueue = previousQueue;
      throw error;
    }

    res.json({ message: "Queue updated successfully", queue: playlistQueue });
  }),
);

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  activeListeners.add(res);

  const removeListener = () => activeListeners.delete(res);
  res.once("close", removeListener);
  res.once("error", removeListener);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/api/live") {
    socket.destroy();
    return;
  }

  liveWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
    liveWebSocketServer.emit("connection", webSocket, req);
  });
});

liveWebSocketServer.on("connection", (webSocket) => {
  let authenticated = false;
  const authTimer = setTimeout(() => webSocket.close(1008, "Authentication required"), 10_000);

  webSocket.on("message", async (data, isBinary) => {
    if (!authenticated) {
      if (isBinary) {
        webSocket.close(1008, "Authentication required");
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        webSocket.close(1008, "Invalid authentication message");
        return;
      }

      if (message.type !== "authenticate" || typeof message.token !== "string") {
        webSocket.close(1008, "Invalid authentication message");
        return;
      }

      try {
        const decoded = await auth.verifyIdToken(message.token, true);
        if (decoded.uid !== adminUid) {
          webSocket.close(1008, "Not authorized");
          return;
        }
      } catch (error) {
        console.warn("Live admin token verification failed:", error.message);
        webSocket.close(1008, "Sign in again");
        return;
      }

      if (webSocket.readyState !== WebSocket.OPEN) return;
      if (liveBroadcastSocket && liveBroadcastSocket.readyState === WebSocket.OPEN) {
        webSocket.close(1013, "A live broadcast is already active");
        return;
      }

      authenticated = true;
      clearTimeout(authTimer);
      liveBroadcastSocket = webSocket;
      currentStreamMode = "LIVE";
      webSocket.send(JSON.stringify({ type: "live", mode: "LIVE" }));
      return;
    }

    if (isBinary) {
      if (currentStreamMode !== "LIVE" || liveBroadcastSocket !== webSocket) return;
      for (const listener of activeListeners) {
        if (!listener.destroyed && !listener.writableEnded) listener.write(data);
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      webSocket.close(1008, "Invalid message");
      return;
    }

    if (message.type === "stop" && liveBroadcastSocket === webSocket) {
      currentStreamMode = "AUTODJ";
      liveBroadcastSocket = null;
      webSocket.send(JSON.stringify({ type: "live", mode: "AUTODJ" }));
      webSocket.close(1000, "Broadcast ended");
    }
  });

  webSocket.once("close", () => {
    clearTimeout(authTimer);
    if (liveBroadcastSocket === webSocket) {
      liveBroadcastSocket = null;
      currentStreamMode = "AUTODJ";
    }
  });
});

async function startAutoDJLoop() {
  while (true) {
    if (currentStreamMode === "LIVE" || playlistQueue.length === 0) {
      await delay(500);
      continue;
    }

    const songId = playlistQueue.shift();
    const song = getSongById(songId);
    if (!song) continue;
    playlistQueue.push(songId);

    console.log(`Auto-DJ streaming: ${song.title} by ${song.author} (${song.id})`);
    const fileStream = bucket.file(song.filePath).createReadStream();

    try {
      for await (const chunk of fileStream) {
        while (currentStreamMode === "LIVE") {
          await delay(250);
        }
        for (const listener of activeListeners) {
          if (!listener.destroyed && !listener.writableEnded) listener.write(chunk);
        }
      }
    } catch (error) {
      console.error(`Error streaming track "${song.title}":`, error.message);
      await delay(1000);
    }
  }
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: error.code === "LIMIT_FILE_SIZE" ? "MP3 files must be 100 MB or smaller" : error.message,
    });
  }

  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error("Request failed:", error);
  res.status(status).json({ error: status >= 500 ? "The server could not complete the request" : error.message });
});

async function startServer() {
  await loadRadioState();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Afterburn Radio running on port ${port}`);
    void startAutoDJLoop();
  });
}

startServer().catch((error) => {
  console.error("Could not start Afterburn Radio:", error);
  process.exitCode = 1;
});
