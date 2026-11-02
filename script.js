const STREAM_URL = "/stream";

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playerStatus = document.querySelector("#player-status");
const playIcon = playButton.querySelector(".play-icon");

if (STREAM_URL) {
  audio.src = STREAM_URL;
  playButton.disabled = false;
  playerStatus.textContent = "Ready to play";
} else {
  playButton.disabled = true;
  playButton.setAttribute("aria-label", "Radio stream is not configured");
}

playButton.addEventListener("click", async () => {
  if (audio.paused) {
    playerStatus.textContent = "Connecting...";

    try {
      await audio.play();
    } catch (error) {
      playerStatus.textContent = "Unable to play the radio stream";
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

audio.addEventListener("error", () => {
  playerStatus.textContent = "Stream unavailable";
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play Afterburn Radio");
  playIcon.textContent = "▶";
});
