const STREAM_URL = "https://afterburn-radio-server.onrender.com/stream";
const PLAYBACK_URL = "https://afterburn-radio-server.onrender.com/api/playback";

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playerStatus = document.querySelector("#player-status");
const playIcon = playButton.querySelector(".play-icon");
let playbackRequest = 0;
let currentStreamMode = null;

function reconnectStreamForModeChange() {
  const shouldResume = !audio.paused;
  const request = ++playbackRequest;

  audio.pause();
  audio.src = STREAM_URL;
  audio.load();

  if (!shouldResume) return;

  playerStatus.textContent = "Reconnecting to the live stream...";
  audio.play().catch((error) => {
    if (request !== playbackRequest) return;
    if (error.name === "AbortError" && audio.paused) return;

    playerStatus.textContent = `Unable to play: ${error.message}`;
    console.error("Unable to resume the radio stream:", error);
  });
}

async function monitorStreamMode() {
  try {
    const response = await fetch(PLAYBACK_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Playback status request failed (${response.status})`);
    }

    const playback = await response.json();
    if (playback.mode !== "LIVE" && playback.mode !== "AUTODJ") {
      throw new Error("The radio server returned an invalid playback mode.");
    }

    if (currentStreamMode !== null && playback.mode !== currentStreamMode) {
      reconnectStreamForModeChange();
    }
    currentStreamMode = playback.mode;
  } catch (error) {
    console.error("Could not check the radio broadcast status:", error);
  } finally {
    window.setTimeout(monitorStreamMode, 1000);
  }
}

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
  playerStatus.textContent = "Now playing";
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
    playerStatus.textContent = "Buffering the radio stream...";
  }
});

audio.addEventListener("error", () => {
  playerStatus.textContent = "Stream unavailable. Try again shortly.";
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play Afterburn Radio");
  playIcon.textContent = "▶";
});

void monitorStreamMode();
