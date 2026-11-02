const STREAM_URL = "https://afterburn-radio-server.onrender.com/stream";

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playerStatus = document.querySelector("#player-status");
const playIcon = playButton.querySelector(".play-icon");

audio.src = STREAM_URL;
playButton.disabled = false;
playerStatus.textContent = "Ready — press play to listen";

playButton.addEventListener("click", async () => {
  if (audio.paused) {
    playerStatus.textContent = "Connecting...";

    try {
      await audio.play();
    } catch (error) {
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
