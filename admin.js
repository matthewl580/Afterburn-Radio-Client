const API_BASE_URL = "https://afterburn-radio-server.onrender.com";
const MP3_SAMPLE_RATE = 44100;
const MP3_BITRATE = 128;
const MP3_CHUNK_SIZE = 8192;
const LIVE_FLUSH_INTERVAL_MS = 250;

const pageStatus = document.querySelector("#page-status");
const tracklistList = document.querySelector("#tracklist-list");
const tracklistEmpty = document.querySelector("#tracklist-empty");
const tracklistCount = document.querySelector("#tracklist-count");
const queueList = document.querySelector("#queue-list");
const queueEmpty = document.querySelector("#queue-empty");
const queueCount = document.querySelector("#queue-count");
const libraryList = document.querySelector("#library-list");
const libraryEmpty = document.querySelector("#library-empty");
const libraryCount = document.querySelector("#library-count");
const uploadForm = document.querySelector("#upload-form");
const refreshButton = document.querySelector("#refresh-button");
const editDialog = document.querySelector("#edit-dialog");
const editForm = document.querySelector("#edit-form");
const liveStartButton = document.querySelector("#live-start");
const liveStopButton = document.querySelector("#live-stop");
const liveStatus = document.querySelector("#live-status");
const liveBadge = document.querySelector("#live-badge");
const currentTrackTitle = document.querySelector("#current-track-title");
const currentTrackArtist = document.querySelector("#current-track-artist");
const skipTrackButton = document.querySelector("#skip-track-button");
const skipStatus = document.querySelector("#skip-status");

let songs = [];
let tracklist = [];
let tracklistIds = [];
let queue = [];
let editingSongId = null;
let microphoneStream = null;
let audioContext = null;
let audioSource = null;
let audioProcessor = null;
let mutedOutput = null;
let mp3Encoder = null;
let pendingMp3Chunks = [];
let pendingMp3Bytes = 0;
let liveUploadChain = Promise.resolve();
let liveUploadError = null;
let liveBroadcastStarted = false;
let liveBroadcastId = null;
let liveCapturing = false;
let liveActive = false;
let stoppingLive = false;
let liveFlushTimer = null;
let playbackMode = null;
let currentPlaybackPosition = 0;
let currentPlaybackSong = null;
let skipPending = false;
let skipPendingSongId = null;

async function apiRequest(path, options = {}) {
  let response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, options);
  } catch (error) {
    throw new Error(`Could not reach the radio server: ${error.message}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let body = null;

  if (contentType.includes("application/json")) {
    body = await response.json();
  } else if (response.status !== 204) {
    body = await response.text();
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && body.error
        ? body.error
        : typeof body === "string" && body
          ? body
          : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return body;
}

function showPageStatus(message, isError = false) {
  pageStatus.textContent = message;
  pageStatus.classList.toggle("is-error", isError);
}

function updateSkipButton() {
  skipTrackButton.disabled =
    !currentPlaybackSong || playbackMode === "LIVE" || skipPending;
}

function renderCurrentPlayback(playback) {
  currentPlaybackSong = playback.song;
  currentPlaybackPosition = Number(playback.positionSeconds) || 0;
  currentTrackTitle.textContent = playback.song
    ? playback.song.title || playback.song.name || "Unknown Title"
    : "No track currently playing";
  currentTrackArtist.textContent = playback.song?.author || "";
  updateSkipButton();
}

async function fetchPlayback() {
  const playback = await apiRequest("/api/playback");
  if (!playback || (playback.mode !== "LIVE" && playback.mode !== "AUTODJ")) {
    throw new Error("The radio server returned an invalid playback state.");
  }
  if (playbackMode === null) playbackMode = playback.mode;
  updateSkipButton();
  return playback;
}

async function refreshCurrentTrackAfterSkip(skippedSongId, nextSongId) {
  const maxAttempts = 20;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const playback = await fetchPlayback();
    const song = playback.song;
    const hasAdvanced =
      song &&
      (song.id !== skippedSongId ||
        nextSongId === skippedSongId ||
        !nextSongId ||
        Number(playback.positionSeconds) < currentPlaybackPosition);

    if (hasAdvanced) {
      renderCurrentPlayback(playback);
      return;
    }

    if (!song && !nextSongId && attempt > 0) {
      renderCurrentPlayback(playback);
      return;
    }
  }

  throw new Error("The server confirmed the skip, but the next track has not started yet.");
}

function connectPlaybackEvents() {
  const events = new EventSource(`${API_BASE_URL}/api/events`);

  events.addEventListener("mode", (event) => {
    try {
      const state = JSON.parse(event.data);
      if (state.mode !== "LIVE" && state.mode !== "AUTODJ") {
        throw new Error("The radio server sent an invalid playback mode.");
      }
      playbackMode = state.mode;
      updateSkipButton();
      if (state.mode === "LIVE") {
        skipStatus.textContent = "Skipping is unavailable during a live broadcast.";
      } else if (!skipPending) {
        skipStatus.textContent = "";
      }
    } catch (error) {
      console.error("Could not read the playback mode event:", error);
    }
  });

  events.addEventListener("playback", (event) => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch (error) {
      console.error("Could not read the playback event:", error);
      return;
    }

    if (update.type !== "track_skipped") return;
    if (
      typeof update.songId !== "string" ||
      (update.nextSongId !== null && typeof update.nextSongId !== "string")
    ) {
      console.error("The server sent an invalid track-skipped event.");
      return;
    }

    const confirmsPendingSkip =
      skipPending && update.songId === skipPendingSongId;
    void refreshCurrentTrackAfterSkip(update.songId, update.nextSongId).then(
      () => {
        if (confirmsPendingSkip) {
          skipPending = false;
          skipPendingSongId = null;
          skipStatus.textContent = "Track skipped.";
        }
        updateSkipButton();
      },
      (error) => {
        if (confirmsPendingSkip) {
          skipPending = false;
          skipPendingSongId = null;
          skipStatus.textContent = error.message;
        }
        updateSkipButton();
        console.error("Could not refresh playback after the track skip:", error);
      },
    );
  });

  events.addEventListener("error", () => {
    if (skipPending) {
      skipStatus.textContent =
        "Waiting for the server to confirm the skip; reconnecting to playback events...";
    }
  });
}

async function initializePlayback() {
  connectPlaybackEvents();

  try {
    const playback = await fetchPlayback();
    renderCurrentPlayback(playback);
    if (playback.mode === "LIVE") {
      skipStatus.textContent = "Skipping is unavailable during a live broadcast.";
    }
  } catch (error) {
    currentTrackTitle.textContent = "Unable to load current track";
    skipStatus.textContent = error.message;
    updateSkipButton();
    console.error("Could not load current playback:", error);
  }
}

async function requestTrackSkip() {
  if (skipTrackButton.disabled) return;

  const requestedSongId = currentPlaybackSong.id;
  skipPending = true;
  skipPendingSongId = requestedSongId;
  skipStatus.textContent = "Queueing skip...";
  updateSkipButton();

  try {
    await apiRequest("/api/playback/skip", { method: "POST" });
    if (skipPending && skipPendingSongId === requestedSongId) {
      skipStatus.textContent =
        "Skip queued. The current track will remain until the server confirms the change.";
    }
  } catch (error) {
    if (skipPending && skipPendingSongId === requestedSongId) {
      skipPending = false;
      skipPendingSongId = null;
      skipStatus.textContent = error.message;
    }
    updateSkipButton();
    console.error("Could not skip the current track:", error);
  }
}

skipTrackButton.addEventListener("click", requestTrackSkip);

function makeButton(label, className, action, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.action = action;
  button.disabled = Boolean(options.disabled);
  button.setAttribute("aria-label", options.ariaLabel || label);
  return button;
}

function makeTrackMeta(song) {
  const meta = document.createElement("div");
  meta.className = "track-meta";

  const title = document.createElement("p");
  title.className = "track-title";
  title.textContent = song.title || song.name || "Unknown Title";

  const artist = document.createElement("p");
  artist.className = "track-artist";
  artist.textContent = song.author || "Unknown Artist";

  meta.append(title, artist);
  return meta;
}

function renderQueue() {
  queueList.replaceChildren();
  queueEmpty.hidden = queue.length > 0;
  queueCount.textContent = `(${queue.length})`;

  queue.forEach((song, index) => {
    const row = document.createElement("li");
    row.className = "track-row";
    row.dataset.id = song.id;

    const position = document.createElement("span");
    position.className = "track-position";
    position.textContent = String(index + 1).padStart(2, "0");
    position.setAttribute("aria-label", `Position ${index + 1}`);

    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(
      makeButton("↑", "icon-button", "move-up", {
        disabled: index === 0,
        ariaLabel: `Move ${song.title || song.name} up`,
      }),
      makeButton("↓", "icon-button", "move-down", {
        disabled: index === queue.length - 1,
        ariaLabel: `Move ${song.title || song.name} down`,
      }),
      makeButton("Remove", "icon-button", "remove-queue", {
        ariaLabel: `Remove ${song.title || song.name} from the upcoming queue`,
      }),
    );

    row.append(position, makeTrackMeta(song), actions);
    queueList.append(row);
  });
}

function renderTracklist() {
  tracklistList.replaceChildren();
  tracklistEmpty.hidden = tracklist.length > 0;
  tracklistCount.textContent = `(${tracklist.length})`;

  tracklist.forEach((song, index) => {
    const row = document.createElement("li");
    row.className = "track-row";
    row.dataset.id = song.id;

    const position = document.createElement("span");
    position.className = "track-position";
    position.textContent = String(index + 1).padStart(2, "0");
    position.setAttribute("aria-label", `Tracklist position ${index + 1}`);

    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(
      makeButton("Remove", "icon-button", "remove-tracklist", {
        ariaLabel: `Remove ${song.title || song.name} from the tracklist`,
      }),
    );

    row.append(position, makeTrackMeta(song), actions);
    tracklistList.append(row);
  });
}

function renderLibrary() {
  libraryList.replaceChildren();
  libraryEmpty.hidden = songs.length > 0;
  libraryCount.textContent = `(${songs.length})`;

  for (const song of songs) {
    const row = document.createElement("li");
    row.className = "track-row";
    row.dataset.id = song.id;

    const meta = makeTrackMeta(song);
    const actions = document.createElement("div");
    actions.className = "track-actions";
    const isInTracklist = tracklistIds.includes(song.id);
    actions.append(
      makeButton(
        isInTracklist ? "In tracklist" : "Add to tracklist",
        "icon-button",
        "add-tracklist",
        {
          disabled: isInTracklist,
          ariaLabel: isInTracklist
            ? `${song.title || song.name} is already in the tracklist`
            : `Add ${song.title || song.name} to the tracklist`,
        },
      ),
      makeButton("Edit", "icon-button", "edit-song", {
        ariaLabel: `Edit ${song.title || song.name}`,
      }),
      makeButton("Delete", "icon-button danger", "delete-song", {
        ariaLabel: `Delete ${song.title || song.name}`,
      }),
    );

    row.append(meta, actions);
    libraryList.append(row);
  }
}

function renderAll() {
  renderTracklist();
  renderQueue();
  renderLibrary();
}

async function loadLibrary() {
  const [loadedSongs, loadedTracklist, loadedQueue] = await Promise.all([
    apiRequest("/api/songs"),
    apiRequest("/api/tracklist"),
    apiRequest("/api/queue"),
  ]);

  if (
    !Array.isArray(loadedSongs) ||
    !loadedTracklist ||
    !Array.isArray(loadedTracklist.tracks) ||
    !Array.isArray(loadedTracklist.trackIds) ||
    !Array.isArray(loadedQueue)
  ) {
    throw new Error("The radio server returned an invalid library or tracklist.");
  }

  songs = loadedSongs;
  tracklist = loadedTracklist.tracks;
  tracklistIds = loadedTracklist.trackIds;
  queue = loadedQueue;
  renderAll();
}

async function refreshLibrary() {
  refreshButton.disabled = true;
  showPageStatus("Loading the library and tracklist...");

  try {
    await loadLibrary();
    showPageStatus("Library and tracklist are up to date.");
  } catch (error) {
    showPageStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

async function saveQueue(nextQueue) {
  const result = await apiRequest("/api/queue", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newQueueIds: nextQueue.map((song) => song.id) }),
  });

  if (!result || !Array.isArray(result.queue)) {
    throw new Error("The radio server did not confirm the upcoming queue update.");
  }

  await loadLibrary();
}

async function updateTracklist(songId, action) {
  if (action === "add-tracklist") {
    await apiRequest("/api/tracklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId }),
    });
  } else {
    await apiRequest(`/api/tracklist/${encodeURIComponent(songId)}`, {
      method: "DELETE",
    });
  }
  await loadLibrary();
}

queueList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const row = button && button.closest(".track-row");
  if (!button || !row) return;

  const index = queue.findIndex((song) => song.id === row.dataset.id);
  if (index < 0) return;

  const nextQueue = [...queue];
  const action = button.dataset.action;

  if (action === "move-up" && index > 0) {
    [nextQueue[index - 1], nextQueue[index]] = [
      nextQueue[index],
      nextQueue[index - 1],
    ];
  } else if (action === "move-down" && index < nextQueue.length - 1) {
    [nextQueue[index + 1], nextQueue[index]] = [
      nextQueue[index],
      nextQueue[index + 1],
    ];
  } else if (action === "remove-queue") {
    nextQueue.splice(index, 1);
  } else {
    return;
  }

  button.disabled = true;
  showPageStatus("Saving upcoming queue...");

  try {
    await saveQueue(nextQueue);
    showPageStatus("Upcoming queue updated.");
  } catch (error) {
    renderQueue();
    showPageStatus(error.message, true);
  }
});

tracklistList.addEventListener("click", async (event) => {
  const button = event.target.closest('button[data-action="remove-tracklist"]');
  const row = button && button.closest(".track-row");
  if (!button || !row) return;

  button.disabled = true;
  showPageStatus("Removing track from the repeating tracklist...");

  try {
    await updateTracklist(row.dataset.id, "remove-tracklist");
    showPageStatus("Track removed from the repeating tracklist.");
  } catch (error) {
    showPageStatus(error.message, true);
    button.disabled = false;
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = uploadForm.querySelector('button[type="submit"]');
  const file = uploadForm.elements.audio.files[0];
  if (!file) return;

  const isMp3 =
    file.type === "audio/mpeg" ||
    file.type === "audio/mp3" ||
    file.name.toLowerCase().endsWith(".mp3");

  if (!isMp3) {
    showPageStatus("Choose an MP3 audio file.", true);
    return;
  }

  submitButton.disabled = true;
  showPageStatus("Uploading track...");

  try {
    await apiRequest("/api/songs", {
      method: "POST",
      body: new FormData(uploadForm),
    });
    uploadForm.reset();
    await loadLibrary();
    showPageStatus("Track uploaded and added to the library and tracklist.");
  } catch (error) {
    showPageStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

libraryList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const row = button && button.closest(".track-row");
  if (!button || !row) return;

  const song = songs.find((item) => item.id === row.dataset.id);
  if (!song) return;

  if (button.dataset.action === "add-tracklist") {
    button.disabled = true;
    showPageStatus(`Adding ${song.title || song.name} to the tracklist...`);

    try {
      await updateTracklist(song.id, "add-tracklist");
      showPageStatus(`${song.title || song.name} added to the repeating tracklist.`);
    } catch (error) {
      showPageStatus(error.message, true);
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.action === "edit-song") {
    editingSongId = song.id;
    editForm.elements.title.value = song.title || "";
    editForm.elements.author.value = song.author || "";
    editDialog.showModal();
    editForm.elements.title.focus();
    return;
  }

  if (
    button.dataset.action !== "delete-song" ||
    !window.confirm(
      `Permanently delete "${song.title || song.name}" from the music library?`,
    )
  ) {
    return;
  }

  button.disabled = true;
  showPageStatus("Deleting track...");

  try {
    await apiRequest(`/api/songs/${encodeURIComponent(song.id)}`, {
      method: "DELETE",
    });
    await loadLibrary();
    showPageStatus("Track deleted.");
  } catch (error) {
    showPageStatus(error.message, true);
    button.disabled = false;
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingSongId) return;

  const title = editForm.elements.title.value.trim();
  const author = editForm.elements.author.value.trim();
  if (!title || !author) {
    showPageStatus("Track title and artist cannot be blank.", true);
    return;
  }

  const submitButton = editForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    await apiRequest(`/api/songs/${encodeURIComponent(editingSongId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        author,
      }),
    });
    editDialog.close();
    editingSongId = null;
    await loadLibrary();
    showPageStatus("Track details updated.");
  } catch (error) {
    showPageStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#edit-cancel").addEventListener("click", () => {
  editingSongId = null;
  editDialog.close();
});

editDialog.addEventListener("close", () => {
  editingSongId = null;
});

refreshButton.addEventListener("click", refreshLibrary);

function appendEncodedAudio(bytes) {
  if (!bytes || bytes.length === 0 || liveUploadError) return;

  const copy = new Uint8Array(bytes);
  pendingMp3Chunks.push(copy);
  pendingMp3Bytes += copy.length;

  if (liveBroadcastStarted && pendingMp3Bytes >= MP3_CHUNK_SIZE) {
    flushEncodedAudio();
  }
}

function flushEncodedAudio() {
  if (!liveBroadcastStarted || !liveBroadcastId || pendingMp3Bytes === 0) return;

  const payload = new Uint8Array(pendingMp3Bytes);
  let offset = 0;
  for (const chunk of pendingMp3Chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }

  pendingMp3Chunks = [];
  pendingMp3Bytes = 0;

  liveUploadChain = liveUploadChain
    .then(async () => {
      if (liveUploadError) return;
      await apiRequest("/api/live/chunk", {
        method: "POST",
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Broadcast-Id": liveBroadcastId,
        },
        body: new Blob([payload], { type: "audio/mpeg" }),
      });
    })
    .catch((error) => {
      liveUploadError = error;
      liveStatus.textContent = `Audio upload failed: ${error.message}`;
      console.error("Live audio upload failed:", error);
      window.setTimeout(() => {
        if (liveActive) void stopLiveBroadcast();
      }, 0);
    });
}

function stopLiveFlushTimer() {
  if (liveFlushTimer === null) return;
  window.clearInterval(liveFlushTimer);
  liveFlushTimer = null;
}

function disconnectMicrophone() {
  liveCapturing = false;
  if (audioProcessor) {
    audioProcessor.onaudioprocess = null;
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }
  if (mutedOutput) {
    mutedOutput.disconnect();
    mutedOutput = null;
  }
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }
  mp3Encoder = null;
}

function setLiveUi(isLive) {
  liveStartButton.hidden = isLive;
  liveStopButton.hidden = !isLive;
  liveBadge.textContent = isLive ? "LIVE" : "AUTO-DJ";
  liveBadge.classList.toggle("is-live", isLive);
}

async function stopLiveBroadcast() {
  if (stoppingLive || (!liveBroadcastStarted && !microphoneStream)) return;
  stoppingLive = true;
  liveActive = false;
  liveCapturing = false;
  stopLiveFlushTimer();
  liveStopButton.disabled = true;
  liveStatus.textContent = "Ending broadcast...";

  if (mp3Encoder) {
    try {
      appendEncodedAudio(mp3Encoder.flush());
      flushEncodedAudio();
    } catch (error) {
      liveUploadError = error;
      console.error("Could not flush the MP3 encoder:", error);
    }
  }

  disconnectMicrophone();

  let stopError = liveUploadError;
  try {
    await liveUploadChain;
  } catch (error) {
    stopError = stopError || error;
  }

  if (liveBroadcastStarted) {
    try {
      await apiRequest("/api/live/end", {
        method: "POST",
        headers: { "X-Broadcast-Id": liveBroadcastId },
      });
      liveBroadcastStarted = false;
      liveBroadcastId = null;
    } catch (error) {
      stopError = stopError || error;
      console.error("Could not end the live broadcast:", error);
    }
  }

  setLiveUi(liveBroadcastStarted);
  liveStopButton.disabled = false;
  stoppingLive = false;
  liveStatus.textContent = stopError
    ? `Broadcast stopped with an error: ${stopError.message}`
    : "Microphone is off. Auto-DJ has resumed.";
}

async function startLiveBroadcast() {
  if (liveActive || liveBroadcastStarted || stoppingLive) return;

  liveStartButton.disabled = true;
  liveStatus.textContent = "Checking microphone and MP3 encoder...";
  liveUploadError = null;
  liveUploadChain = Promise.resolve();
  pendingMp3Chunks = [];
  pendingMp3Bytes = 0;

  try {
    if (!window.lamejs || !window.lamejs.Mp3Encoder) {
      throw new Error("The MP3 encoder did not load. Check your internet connection and try again.");
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone access requires a supported browser on HTTPS or localhost.");
    }

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const AudioContextConstructor =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("This browser does not support microphone audio processing.");
    }

    audioContext = new AudioContextConstructor({
      sampleRate: MP3_SAMPLE_RATE,
    });
    if (audioContext.sampleRate !== MP3_SAMPLE_RATE) {
      throw new Error(
        `This browser uses ${audioContext.sampleRate} Hz audio; the station requires ${MP3_SAMPLE_RATE} Hz.`,
      );
    }
    await audioContext.resume();

    mp3Encoder = new window.lamejs.Mp3Encoder(
      1,
      audioContext.sampleRate,
      MP3_BITRATE,
    );
    audioSource = audioContext.createMediaStreamSource(microphoneStream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    mutedOutput = audioContext.createGain();
    mutedOutput.gain.value = 0;

    audioProcessor.onaudioprocess = (event) => {
      if (!liveCapturing || liveUploadError) return;

      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      appendEncodedAudio(mp3Encoder.encodeBuffer(pcm));
    };

    audioSource.connect(audioProcessor);
    audioProcessor.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);
    liveCapturing = true;

    const broadcast = await apiRequest("/api/live/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mimeType: "audio/mpeg",
        channels: 1,
        sampleRate: audioContext.sampleRate,
        bitrate: MP3_BITRATE * 1000,
      }),
    });
    if (
      !broadcast ||
      typeof broadcast.broadcastId !== "string" ||
      !broadcast.broadcastId
    ) {
      throw new Error("The radio server did not return a broadcast ID.");
    }
    liveBroadcastId = broadcast.broadcastId;
    liveBroadcastStarted = true;
    if (
      broadcast.audioFormat?.sampleRate &&
      broadcast.audioFormat.sampleRate !== audioContext.sampleRate
    ) {
      throw new Error(
        `The server expects ${broadcast.audioFormat.sampleRate} Hz audio, but the encoder is using ${audioContext.sampleRate} Hz.`,
      );
    }
    liveActive = true;
    stoppingLive = false;

    flushEncodedAudio();

    liveFlushTimer = window.setInterval(
      flushEncodedAudio,
      LIVE_FLUSH_INTERVAL_MS,
    );
    setLiveUi(true);
    liveStatus.textContent = "Live — microphone audio is on air.";
  } catch (error) {
    console.error("Could not start live broadcast:", error);
    liveActive = false;
    stopLiveFlushTimer();
    disconnectMicrophone();

    if (liveBroadcastStarted) {
      try {
        await apiRequest("/api/live/end", {
          method: "POST",
          headers: { "X-Broadcast-Id": liveBroadcastId },
        });
        liveBroadcastStarted = false;
        liveBroadcastId = null;
      } catch (endError) {
        console.error("Could not restore Auto-DJ after start failure:", endError);
        liveStatus.textContent = `${error.message} Auto-DJ restart also failed: ${endError.message}`;
        setLiveUi(liveBroadcastStarted);
        liveStartButton.disabled = false;
        return;
      }
    }

    liveStatus.textContent = error.message;
    setLiveUi(false);
  } finally {
    liveStartButton.disabled = false;
  }
}

liveStartButton.addEventListener("click", startLiveBroadcast);
liveStopButton.addEventListener("click", stopLiveBroadcast);

void initializePlayback();

window.addEventListener("pagehide", () => {
  if (liveBroadcastStarted) {
    void fetch(`${API_BASE_URL}/api/live/end`, {
      method: "POST",
      keepalive: true,
      headers: { "X-Broadcast-Id": liveBroadcastId },
    }).catch((error) => {
      console.error("Could not stop the live broadcast on page exit:", error);
    });
  }
});

void refreshLibrary();