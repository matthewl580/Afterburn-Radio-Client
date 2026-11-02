const STREAM_URL = "https://afterburn-radio-server.onrender.com/stream";
const EVENTS_URL = "https://afterburn-radio-server.onrender.com/api/events";

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playerStatus = document.querySelector("#player-status");
const playIcon = playButton.querySelector(".play-icon");
let playbackRequest = 0;
let currentStreamMode = null;

function updatePlayingStatus() {
  playerStatus.textContent =
    currentStreamMode === "LIVE" ? "Live broadcast" : "Now playing";
}

const playbackEvents = new EventSource(EVENTS_URL);
playbackEvents.addEventListener("mode", (event) => {
  try {
    const state = JSON.parse(event.data);
    if (state.mode !== "LIVE" && state.mode !== "AUTODJ") {
      throw new Error("The radio server sent an invalid playback mode.");
    }

    currentStreamMode = state.mode;
    if (!audio.paused) updatePlayingStatus();
  } catch (error) {
    console.error("Could not read the radio broadcast status:", error);
  }
});

audio.src = STREAM_URL;
playButton.disabled = false;
playerStatus.textContent = "Ready — press play to listen";

playButton.addEventListener("click", async () => {
  const request = ++playbackRequest;

  if (audio.paused) {
    playerStatus.textContent = "Connecting...";

    try {
      await audio.play();
    } catch (error) {
      if (request !== playbackRequest) return;
      if (error.name === "AbortError" && audio.paused) return;

      playerStatus.textContent = `Unable to play: ${error.message}`;
      console.error("Unable to play the radio stream:", error);
    }
  } else {
    audio.pause();
  }
});

audio.addEventListener("playing", () => {
  updatePlayingStatus();
  playButton.classList.add("is-playing");
  playButton.setAttribute("aria-label", "Pause Afterburn Radio");
  playIcon.textContent = "Ⅱ";
});

audio.addEventListener("pause", () => {
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
