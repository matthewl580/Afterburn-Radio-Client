import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const loginPanel = document.querySelector("#login-panel");
const loginForm = document.querySelector("#login-form");
const loginNotice = document.querySelector("#login-notice");
const dashboard = document.querySelector("#dashboard");
const signedIn = document.querySelector("#signed-in");
const uploadForm = document.querySelector("#upload-form");
const uploadNotice = document.querySelector("#upload-notice");
const trackList = document.querySelector("#track-list");
const trackCount = document.querySelector("#track-count");
const tracksNotice = document.querySelector("#tracks-notice");
const liveButton = document.querySelector("#live-button");
const liveNotice = document.querySelector("#live-notice");
const modeBadge = document.querySelector("#mode-badge");

let auth;
let tracks = [];
let liveSocket = null;
let microphoneStream = null;
let audioContext = null;
let audioSource = null;
let audioProcessor = null;
let silentGain = null;
let mp3Encoder = null;
let pendingSamples = new Float32Array(0);
let liveReady = false;
let liveStarting = false;

function setNotice(element, message, kind = "") {
  element.textContent = message;
  if (kind) element.dataset.kind = kind;
  else delete element.dataset.kind;
}

async function api(url, options = {}, user = auth.currentUser) {
  const headers = new Headers(options.headers || {});
  if (user) headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}

function createButton(label, className, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", action);
  return button;
}

async function refreshTracks() {
  try {
    tracks = await api("/api/queue");
    renderTracks();
    setNotice(tracksNotice, "");
    return true;
  } catch (error) {
    setNotice(tracksNotice, error.message, "error");
    return false;
  }
}

function renderTracks() {
  trackList.replaceChildren();
  trackCount.textContent = `(${tracks.length})`;

  if (tracks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No tracks in the rotation yet. Upload an MP3 to get started.";
    trackList.append(empty);
    return;
  }

  tracks.forEach((track, index) => {
    const row = document.createElement("li");
    row.className = "track-row";

    const position = document.createElement("span");
    position.className = "track-position";
    position.textContent = String(index + 1).padStart(2, "0");

    const fields = document.createElement("div");
    fields.className = "track-fields";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "TITLE";
    const titleInput = document.createElement("input");
    titleInput.value = track.title;
    titleInput.maxLength = 150;
    titleInput.setAttribute("aria-label", `Title for ${track.title}`);
    titleLabel.append(titleInput);

    const authorLabel = document.createElement("label");
    authorLabel.textContent = "ARTIST";
    const authorInput = document.createElement("input");
    authorInput.value = track.author;
    authorInput.maxLength = 150;
    authorInput.setAttribute("aria-label", `Artist for ${track.title}`);
    authorLabel.append(authorInput);
    fields.append(titleLabel, authorLabel);

    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(
      createButton("↑", "button-quiet", `Move ${track.title} up`, () => moveTrack(index, -1)),
      createButton("↓", "button-quiet", `Move ${track.title} down`, () => moveTrack(index, 1)),
      createButton("SAVE", "button-quiet", `Save ${track.title}`, async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api(`/api/songs/${encodeURIComponent(track.id)}`, {
            method: "PUT",
            body: JSON.stringify({ title: titleInput.value, author: authorInput.value }),
          });
          if (await refreshTracks()) {
            setNotice(tracksNotice, "Track details saved.", "success");
          }
        } catch (error) {
          setNotice(tracksNotice, error.message, "error");
        } finally {
          button.disabled = false;
        }
      }),
      createButton("DELETE", "button-danger", `Delete ${track.title}`, async (event) => {
        if (!window.confirm(`Remove "${track.title}" from the station? This also deletes its uploaded audio.`)) {
          return;
        }

        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api(`/api/songs/${encodeURIComponent(track.id)}`, { method: "DELETE" });
          if (await refreshTracks()) {
            setNotice(tracksNotice, "Track removed.", "success");
          }
        } catch (error) {
          setNotice(tracksNotice, error.message, "error");
        } finally {
          button.disabled = false;
        }
      }),
    );

    row.append(position, fields, actions);
    trackList.append(row);
  });
}

async function moveTrack(index, offset) {
  const destination = index + offset;
  if (destination < 0 || destination >= tracks.length) return;

  const reordered = [...tracks];
  [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
  try {
    await api("/api/queue", {
      method: "PUT",
      body: JSON.stringify({ newQueueIds: reordered.map((track) => track.id) }),
    });
    tracks = reordered;
    renderTracks();
    setNotice(tracksNotice, "Auto-DJ order updated.", "success");
  } catch (error) {
    setNotice(tracksNotice, error.message, "error");
  }
}

function setLiveMode(isLive) {
  modeBadge.textContent = isLive ? "LIVE" : "AUTO-DJ";
  modeBadge.classList.toggle("is-live", isLive);
  liveButton.textContent = isLive ? "■ END LIVE" : "● START LIVE";
  liveButton.classList.toggle("is-live", isLive);
  liveButton.disabled = false;
}

function releaseMicrophone() {
  if (audioProcessor) {
    audioProcessor.onaudioprocess = null;
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) track.stop();
    microphoneStream = null;
  }
  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }
  mp3Encoder = null;
  pendingSamples = new Float32Array(0);
}

function finishLive(message, kind = "") {
  liveReady = false;
  liveStarting = false;
  liveSocket = null;
  releaseMicrophone();
  setLiveMode(false);
  if (message) setNotice(liveNotice, message, kind);
}

function sendPcmAsMp3(samples) {
  const combined = new Float32Array(pendingSamples.length + samples.length);
  combined.set(pendingSamples);
  combined.set(samples, pendingSamples.length);

  const frameSize = 1152;
  let offset = 0;
  while (offset + frameSize <= combined.length) {
    const pcm = new Int16Array(frameSize);
    for (let index = 0; index < frameSize; index += 1) {
      const sample = Math.max(-1, Math.min(1, combined[offset + index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    const encoded = mp3Encoder.encodeBuffer(pcm);
    if (encoded.length && liveSocket?.readyState === WebSocket.OPEN) {
      if (liveSocket.bufferedAmount > 512 * 1024) {
        stopLive("Network is too slow for a stable live broadcast.", "error");
        return;
      }
      liveSocket.send(encoded);
    }
    offset += frameSize;
  }

  pendingSamples = combined.slice(offset);
}

function beginMicrophoneEncoding() {
  if (!window.lamejs?.Mp3Encoder) {
    throw new Error("The MP3 encoder did not load. Refresh the page and try again.");
  }

  const sampleRate = audioContext.sampleRate;
  const supportedSampleRates = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  if (!supportedSampleRates.includes(sampleRate)) {
    throw new Error(`The microphone sample rate (${sampleRate} Hz) is not supported.`);
  }

  mp3Encoder = new window.lamejs.Mp3Encoder(1, sampleRate, 128);
  audioSource = audioContext.createMediaStreamSource(microphoneStream);
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  audioProcessor.onaudioprocess = (event) => {
    if (mp3Encoder) sendPcmAsMp3(event.inputBuffer.getChannelData(0));
  };

  audioSource.connect(audioProcessor);
  audioProcessor.connect(silentGain);
  silentGain.connect(audioContext.destination);
}

async function startLive() {
  liveStarting = true;
  liveButton.disabled = true;
  setNotice(liveNotice, "Requesting microphone access...");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access requires HTTPS or localhost.");
    }

    audioContext = new AudioContext({ sampleRate: 44100 });
    await audioContext.resume();
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const token = await auth.currentUser.getIdToken();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${window.location.host}/api/live`);
    liveSocket.binaryType = "arraybuffer";

    liveSocket.onopen = () => {
      liveSocket.send(JSON.stringify({ type: "authenticate", token }));
      setNotice(liveNotice, "Connecting to the station...");
    };

    liveSocket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        stopLive("The server returned an invalid response.", "error");
        return;
      }

      if (message.type === "live" && message.mode === "LIVE") {
        try {
          beginMicrophoneEncoding();
          liveReady = true;
          liveStarting = false;
          setLiveMode(true);
          setNotice(liveNotice, "You are live. Everyone listening can hear your microphone.", "success");
        } catch (error) {
          stopLive(error.message, "error");
        }
      }
    };

    liveSocket.onerror = () => {
      finishLive("Could not connect to the live broadcast service.", "error");
    };

    liveSocket.onclose = (event) => {
      const wasLive = liveReady || liveStarting;
      finishLive(
        wasLive && event.code !== 1000 ? "Live connection ended. Auto-DJ is back on." : "",
        wasLive && event.code !== 1000 ? "error" : "",
      );
    };
  } catch (error) {
    if (liveSocket && liveSocket.readyState < WebSocket.CLOSING) liveSocket.close();
    finishLive(error.message, "error");
  }
}

function stopLive(message = "Broadcast ended. Auto-DJ is back on.", kind = "success") {
  const socket = liveSocket;
  if (socket?.readyState === WebSocket.OPEN && liveReady) {
    socket.send(JSON.stringify({ type: "stop" }));
    liveReady = false;
    liveStarting = false;
    liveButton.disabled = true;
    setNotice(liveNotice, "Ending live broadcast...");
    releaseMicrophone();
    window.setTimeout(() => {
      if (liveSocket === socket) socket.close();
    }, 2000);
    socket.addEventListener(
      "close",
      () => finishLive(message, kind),
      { once: true },
    );
    return;
  }

  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  finishLive(message, kind);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = loginForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  setNotice(loginNotice, "Signing in...");

  try {
    await signInWithEmailAndPassword(
      auth,
      document.querySelector("#email").value.trim(),
      document.querySelector("#password").value,
    );
  } catch (error) {
    setNotice(loginNotice, error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#sign-out").addEventListener("click", async () => {
  if (liveSocket) stopLive("Broadcast ended because you signed out.");
  await signOut(auth);
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = uploadForm.querySelector("button[type=submit]");
  const file = document.querySelector("#track-audio").files[0];
  if (!file) {
    setNotice(uploadNotice, "Choose an MP3 file first.", "error");
    return;
  }

  const formData = new FormData(uploadForm);
  button.disabled = true;
  setNotice(uploadNotice, "Uploading track...");
  try {
    await api("/api/songs", { method: "POST", body: formData });
    uploadForm.reset();
    setNotice(uploadNotice, "Track uploaded and added to the rotation.", "success");
    await refreshTracks();
  } catch (error) {
    setNotice(uploadNotice, error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#refresh-tracks").addEventListener("click", refreshTracks);
liveButton.addEventListener("click", () => {
  if (liveReady) stopLive();
  else if (!liveStarting) void startLive();
});

window.addEventListener("beforeunload", () => {
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ type: "stop" }));
    liveSocket.close();
  }
  releaseMicrophone();
});

async function initializeAdmin() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || "Could not load Firebase configuration");

    auth = getAuth(initializeApp(config));
    for (const control of loginForm.elements) control.disabled = false;
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        loginPanel.hidden = false;
        dashboard.hidden = true;
        signedIn.textContent = "";
        return;
      }

      try {
        await api("/api/admin/session", {}, user);
        loginPanel.hidden = true;
        dashboard.hidden = false;
        signedIn.textContent = `SIGNED IN: ${user.email || user.uid}`;
        setNotice(loginNotice, "");
        await refreshTracks();
      } catch (error) {
        await signOut(auth);
        loginPanel.hidden = false;
        dashboard.hidden = true;
        setNotice(loginNotice, error.message, "error");
      }
    });
  } catch (error) {
    setNotice(loginNotice, error.message, "error");
  }
}

void initializeAdmin();
