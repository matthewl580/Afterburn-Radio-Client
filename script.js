const STREAM_URL = "https://afterburn-radio-server.onrender.com/stream";
const EVENTS_URL = "https://afterburn-radio-server.onrender.com/api/events";

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playerStatus = document.querySelector("#player-status");
const currentSongTitle = document.querySelector("#current-song-title");
const currentSongAuthor = document.querySelector("#current-song-author");
const playIcon = playButton.querySelector(".play-icon");
let playbackRequest = 0;
let currentStreamMode = null;
let playbackRequested = false;
let reconnectPending = false;
let playbackInfoRequestPending = false;

function renderCurrentSong(playback) {
  currentStreamMode = playback.mode;

  if (playback.mode === "LIVE") {
    currentSongTitle.textContent = "Live broadcast";
    currentSongAuthor.textContent = "Microphone transmission";
    return;
  }

  if (!playback.song) {
    currentSongTitle.textContent = "Waiting for the next track";
    currentSongAuthor.textContent = "";
    return;
  }

  currentSongTitle.textContent =
    playback.song.title || playback.song.name || "Untitled track";
  currentSongAuthor.textContent = playback.song.author || "Unknown artist";
}

async function refreshCurrentSong() {
  if (playbackInfoRequestPending) return;
  playbackInfoRequestPending = true;

  try {
    const response = await fetch(
      "https://afterburn-radio-server.onrender.com/api/playback",
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`Playback request failed (${response.status})`);
    }

    const playback = await response.json();
    if (
      (playback.mode !== "LIVE" && playback.mode !== "AUTODJ") ||
      (playback.song !== null && typeof playback.song !== "object")
    ) {
      throw new Error("The radio server returned invalid playback information.");
    }
    renderCurrentSong(playback);
  } catch (error) {
    currentSongTitle.textContent = "Track information unavailable";
    currentSongAuthor.textContent = "";
    console.error("Could not load the current track:", error);
  } finally {
    playbackInfoRequestPending = false;
  }
}

function updatePlayingStatus() {
  playerStatus.textContent =
    currentStreamMode === "LIVE" ? "Live broadcast" : "Now playing";
}

function resumeLivePlayback(forceReconnect = false) {
  if (
    !playbackRequested ||
    (!forceReconnect && !audio.paused) ||
    reconnectPending
  ) {
    return;
  }

  reconnectPending = true;
  const request = ++playbackRequest;
  playerStatus.textContent = "Reconnecting to the radio stream...";
  audio.src = `${STREAM_URL}?reconnect=${Date.now()}`;
  audio.load();
  audio.play()
    .then(() => {
      if (request === playbackRequest) reconnectPending = false;
    })
    .catch((error) => {
      if (request !== playbackRequest || !playbackRequested) return;
      reconnectPending = false;
      if (error.name === "AbortError" && audio.paused) return;

      playerStatus.textContent = `Unable to play the radio stream: ${error.message}`;
      console.error("Unable to resume the live radio stream:", error);
    });
}

const playbackEvents = new EventSource(EVENTS_URL);
playbackEvents.addEventListener("mode", (event) => {
  try {
    const state = JSON.parse(event.data);
    if (state.mode !== "LIVE" && state.mode !== "AUTODJ") {
      throw new Error("The radio server sent an invalid playback mode.");
    }

    const previousMode = currentStreamMode;
    currentStreamMode = state.mode;
    void refreshCurrentSong();
    if (
      playbackRequested &&
      state.mode === "LIVE" &&
      previousMode !== "LIVE"
    ) {
      resumeLivePlayback(true);
    } else if (playbackRequested && audio.paused) {
      resumeLivePlayback();
    } else if (!audio.paused) {
      updatePlayingStatus();
    }
  } catch (error) {
    console.error("Could not read the radio broadcast status:", error);
  }
});
playbackEvents.addEventListener("playback", () => {
  void refreshCurrentSong();
});

void refreshCurrentSong();
window.setInterval(refreshCurrentSong, 5000);

audio.src = STREAM_URL;
playButton.disabled = false;
playerStatus.textContent = "Ready — press play to listen";

playButton.addEventListener("click", async () => {
  const request = ++playbackRequest;

  if (audio.paused) {
    playbackRequested = true;
    playerStatus.textContent = "Connecting...";

    try {
      await audio.play();
    } catch (error) {
      if (request !== playbackRequest) return;
      if (error.name === "AbortError" && audio.paused) return;

      playerStatus.textContent =
        error.name === "NotAllowedError"
          ? "Autoplay was blocked — press play to listen."
          : `Unable to play: ${error.message}`;
      console.error("Unable to play the radio stream:", error);
    }
  } else {
    playbackRequested = false;
    reconnectPending = false;
    audio.pause();
  }
});

audio.addEventListener("playing", () => {
  reconnectPending = false;
  updatePlayingStatus();
  playButton.classList.add("is-playing");
  playButton.setAttribute("aria-label", "Pause Afterburn Radio");
  playIcon.textContent = "Ⅱ";
});

audio.addEventListener("pause", () => {
  if (playbackRequested) {
    window.setTimeout(resumeLivePlayback, 0);
    return;
  }

  playerStatus.textContent = "Paused";
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play Afterburn Radio");
  playIcon.textContent = "▶";
});

audio.addEventListener("waiting", () => {
  if (!audio.paused) {
    playerStatus.textContent =
      currentStreamMode === "LIVE"
        ? "Buffering the live broadcast..."
        : "Buffering the radio stream...";
  }
});

audio.addEventListener("error", () => {
  playerStatus.textContent = "Stream unavailable. Try again shortly.";
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play Afterburn Radio");
  playIcon.textContent = "▶";
});

if (new URLSearchParams(window.location.search).get("autostart") === "true") {
  playButton.click();
}
