const MODEL = "gpt-realtime-1.5";
const VOICE = "marin";
const TARGET_SAMPLE_RATE = 24000;
const VAD_THRESHOLD = 0.02;
const VAD_START_MS = 140;
const VAD_STOP_MS = 520;
const VAD_MIN_TURN_MS = 280;
const PRE_ROLL_MS = 250;
const MAX_TURN_MS = 30000;
const AUDIO_APPEND_CHUNK_SAMPLES = 4800;
const DATA_CHANNEL_HIGH_WATER_MARK = 256000;
const DATA_CHANNEL_LOW_WATER_MARK = 64000;
const MAX_IMAGE_BYTES = 180000;
const DEFAULT_INSTRUCTIONS =
  "You are a realtime desktop copilot. Match the user's language. " +
  "When a screenshot user message arrives immediately before an audio turn, treat it as the current screen " +
  "the user was looking at for that same utterance and use it together with the voice input. " +
  "Answer conversationally and keep responses concise unless the user asks for detail.";

const els = {
  connectButton: document.getElementById("connectButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  shareButton: document.getElementById("shareButton"),
  apiKeyButton: document.getElementById("apiKeyButton"),
  connectionValue: document.getElementById("connectionValue"),
  listeningValue: document.getElementById("listeningValue"),
  screenValue: document.getElementById("screenValue"),
  apiKeyValue: document.getElementById("apiKeyValue"),
  conversationList: document.getElementById("conversationList"),
  logList: document.getElementById("logList"),
  meterFill: document.getElementById("meterFill"),
  screenPreview: document.getElementById("screenPreview"),
  previewPlaceholder: document.getElementById("previewPlaceholder"),
  apiKeyModal: document.getElementById("apiKeyModal"),
  apiKeyForm: document.getElementById("apiKeyForm"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  rememberKeyCheckbox: document.getElementById("rememberKeyCheckbox"),
  apiKeyHelpText: document.getElementById("apiKeyHelpText"),
  sessionOnlyButton: document.getElementById("sessionOnlyButton"),
  clearKeyButton: document.getElementById("clearKeyButton"),
  closeApiKeyModalButton: document.getElementById("closeApiKeyModalButton"),
  captureSourceModal: document.getElementById("captureSourceModal"),
  captureSourceList: document.getElementById("captureSourceList"),
  closeCaptureSourceModalButton: document.getElementById("closeCaptureSourceModalButton"),
};

const state = {
  connecting: false,
  connected: false,
  peerConnection: null,
  dataChannel: null,
  remoteAudio: null,
  micStream: null,
  screenStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  sinkNode: null,
  responseInProgress: false,
  assistantMessageId: null,
  logs: [],
  messages: [],
  turnCounter: 0,
  desktop: {
    enabled: Boolean(window.desktopBridge?.isDesktop),
    apiKeyMode: "web",
    hasKey: true,
    canPersist: false,
    apiModalLocked: false,
  },
  audio: {
    sampleRate: 48000,
    micLevel: 0,
    preRollChunks: [],
    preRollSamples: 0,
    speaking: false,
    loudMs: 0,
    silenceMs: 0,
    activeChunks: [],
    activeSamples: 0,
    flushing: false,
  },
};

syncUi();
renderLogs();
renderMessages();
void initDesktopMode();

els.connectButton.addEventListener("click", () => {
  void connectRealtime();
});
els.disconnectButton.addEventListener("click", () => {
  disconnectRealtime();
});
els.shareButton.addEventListener("click", () => {
  void toggleScreenShare();
});
els.apiKeyButton.addEventListener("click", () => {
  openApiKeyModal({ locked: false });
});
els.apiKeyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveApiKeyFromModal({ persist: els.rememberKeyCheckbox.checked });
});
els.sessionOnlyButton.addEventListener("click", () => {
  void saveApiKeyFromModal({ persist: false });
});
els.clearKeyButton.addEventListener("click", () => {
  void clearStoredApiKey();
});
els.closeApiKeyModalButton.addEventListener("click", () => {
  closeApiKeyModal();
});
els.closeCaptureSourceModalButton.addEventListener("click", () => {
  closeCaptureSourceModal();
});
window.addEventListener("beforeunload", () => {
  disconnectRealtime({ silent: true });
});

function syncUi() {
  els.connectButton.disabled = state.connecting || state.connected;
  els.disconnectButton.disabled = !state.connected && !state.connecting;
  els.shareButton.disabled = !state.connected;
  els.shareButton.textContent = state.screenStream ? "Stop Screen Share" : "Start Screen Share";
  els.apiKeyButton.hidden = !state.desktop.enabled;
  els.connectionValue.textContent = state.connected
    ? state.responseInProgress
      ? "Connected / Speaking"
      : "Connected"
    : state.connecting
      ? "Connecting..."
      : "Disconnected";
  els.listeningValue.textContent = state.audio.speaking
    ? "Listening for turn end"
    : state.connected
      ? "Waiting for speech"
      : "Idle";
  els.screenValue.textContent = state.screenStream ? "On" : "Off";
  els.apiKeyValue.textContent = getApiKeyStatusLabel();
  els.meterFill.style.width = `${Math.min(100, state.audio.micLevel * 900)}%`;
  els.screenPreview.style.display = state.screenStream ? "block" : "none";
  els.previewPlaceholder.style.display = state.screenStream ? "none" : "grid";
  els.closeApiKeyModalButton.hidden = state.desktop.apiModalLocked;
  els.rememberKeyCheckbox.disabled = state.desktop.enabled && !state.desktop.canPersist;
}

async function initDesktopMode() {
  if (!state.desktop.enabled) {
    state.desktop.apiKeyMode = "web";
    state.desktop.hasKey = true;
    syncUi();
    return;
  }

  try {
    const meta = await window.desktopBridge.getAppMeta();
    log(`${meta.productName} ${meta.version} running in desktop mode.`);
  } catch {
    log("Desktop mode detected.", "warn");
  }

  await refreshApiKeyState();
  if (!state.desktop.hasKey) {
    openApiKeyModal({ locked: true });
  }
}

function getApiKeyStatusLabel() {
  if (!state.desktop.enabled) {
    return "Desktop Only";
  }
  if (state.desktop.apiKeyMode === "stored") {
    return "Stored on this PC";
  }
  if (state.desktop.apiKeyMode === "session") {
    return "Session Only";
  }
  return "Missing";
}

async function refreshApiKeyState() {
  if (!state.desktop.enabled) {
    return {
      hasKey: true,
      mode: "web",
      canPersist: false,
    };
  }

  const nextState = await window.desktopBridge.getApiKeyState();
  state.desktop.hasKey = nextState.hasKey;
  state.desktop.apiKeyMode = nextState.mode;
  state.desktop.canPersist = nextState.canPersist;
  if (!nextState.canPersist) {
    els.rememberKeyCheckbox.checked = false;
  }
  syncUi();
  return nextState;
}

async function ensureApiKeyReady() {
  if (!state.desktop.enabled) {
    return true;
  }

  const nextState = await refreshApiKeyState();
  if (nextState.hasKey) {
    return true;
  }

  openApiKeyModal({ locked: true });
  log("Desktop build needs an OpenAI API key before connecting.", "warn");
  return false;
}

function openApiKeyModal(options = {}) {
  const { locked = false } = options;
  state.desktop.apiModalLocked = locked;
  els.apiKeyModal.hidden = false;
  if (!state.desktop.canPersist) {
    els.rememberKeyCheckbox.checked = false;
  }
  setApiKeyHelpText(
    state.desktop.canPersist
      ? "저장을 켜면 이 PC의 사용자 데이터 폴더에 OS 암호화로만 보관합니다."
      : "이 PC에서는 암호화 저장소를 사용할 수 없어 이번 실행에만 메모리로 유지됩니다.",
  );
  syncUi();
  window.setTimeout(() => {
    els.apiKeyInput.focus();
  }, 0);
}

function closeApiKeyModal() {
  if (state.desktop.apiModalLocked) {
    return;
  }
  els.apiKeyModal.hidden = true;
}

async function saveApiKeyFromModal(options = {}) {
  const persist = Boolean(options.persist);
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    setApiKeyHelpText("OpenAI API key를 먼저 입력해주세요.", "bad");
    els.apiKeyInput.focus();
    return;
  }

  try {
    const nextState = await window.desktopBridge.saveApiKey(apiKey, persist);
    state.desktop.hasKey = nextState.hasKey;
    state.desktop.apiKeyMode = nextState.mode;
    state.desktop.canPersist = nextState.canPersist;
    state.desktop.apiModalLocked = false;
    els.apiKeyInput.value = "";
    setApiKeyHelpText(
      nextState.warning ||
        (nextState.mode === "stored"
          ? "API key를 이 PC에만 암호화 저장했습니다."
          : "API key를 이번 실행 동안만 메모리에 보관합니다."),
      nextState.warning ? "warn" : "good",
    );
    els.apiKeyModal.hidden = true;
    syncUi();
    log(
      nextState.mode === "stored"
        ? "Saved the API key to this PC using OS encryption."
        : "Stored the API key in memory for this session only.",
      "good",
    );
  } catch (error) {
    setApiKeyHelpText(error.message || "API key 저장에 실패했습니다.", "bad");
  }
}

async function clearStoredApiKey() {
  if (!state.desktop.enabled) {
    return;
  }

  try {
    const nextState = await window.desktopBridge.clearApiKey();
    state.desktop.hasKey = nextState.hasKey;
    state.desktop.apiKeyMode = nextState.mode;
    state.desktop.canPersist = nextState.canPersist;
    state.desktop.apiModalLocked = true;
    els.apiKeyInput.value = "";
    setApiKeyHelpText("저장된 key와 세션 메모리 key를 모두 지웠습니다.", "warn");
    syncUi();
    log("Cleared the stored API key from this PC.", "warn");
  } catch (error) {
    setApiKeyHelpText(error.message || "저장된 key 삭제에 실패했습니다.", "bad");
  }
}

function setApiKeyHelpText(message, tone = "info") {
  els.apiKeyHelpText.textContent = message;
  els.apiKeyHelpText.dataset.tone = tone;
}

async function connectRealtime() {
  if (state.connecting || state.connected) {
    return;
  }

  if (!(await ensureApiKeyReady())) {
    return;
  }

  state.connecting = true;
  log("Requesting microphone access and opening a Realtime WebRTC session.");
  syncUi();

  try {
    await ensureMicrophonePipeline();

    const peerConnection = new RTCPeerConnection();
    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;

    peerConnection.addTransceiver("audio", { direction: "recvonly" });
    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      void remoteAudio.play().catch(() => {
        log("Remote audio is ready, but the browser blocked autoplay until interaction.", "warn");
      });
    };
    peerConnection.onconnectionstatechange = () => {
      const value = peerConnection.connectionState;
      if (value === "failed" || value === "disconnected" || value === "closed") {
        log(`Peer connection changed to ${value}.`, value === "failed" ? "bad" : "warn");
        disconnectRealtime({ silent: value === "closed" });
      }
      syncUi();
    };

    const dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", handleDataChannelOpen);
    dataChannel.addEventListener("message", handleRealtimeEvent);
    dataChannel.addEventListener("close", () => {
      log("Realtime data channel closed.", "warn");
    });
    dataChannel.addEventListener("error", () => {
      log("Realtime data channel reported an error.", "bad");
    });

    state.peerConnection = peerConnection;
    state.dataChannel = dataChannel;
    state.remoteAudio = remoteAudio;

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const answerSdp = await requestRealtimeAnswerSdp(offer.sdp);

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
  } catch (error) {
    log(error.message || "Failed to connect to the Realtime session.", "bad");
    disconnectRealtime({ silent: true });
  } finally {
    state.connecting = false;
    syncUi();
  }
}

async function requestRealtimeAnswerSdp(offerSdp) {
  if (!state.desktop.enabled || !window.desktopBridge?.createRealtimeSession) {
    throw new Error("This public build must be launched through the Electron desktop app.");
  }

  const result = await window.desktopBridge.createRealtimeSession(offerSdp);
  return result.sdp;
}

function disconnectRealtime(options = {}) {
  const { silent = false } = options;

  if (state.dataChannel) {
    try {
      state.dataChannel.close();
    } catch {}
  }

  if (state.peerConnection) {
    try {
      state.peerConnection.close();
    } catch {}
  }

  if (state.remoteAudio) {
    try {
      state.remoteAudio.pause();
      state.remoteAudio.srcObject = null;
    } catch {}
  }

  stopScreenShare();
  closeCaptureSourceModal();
  stopMicrophonePipeline();

  state.connecting = false;
  state.connected = false;
  state.responseInProgress = false;
  state.peerConnection = null;
  state.dataChannel = null;
  state.remoteAudio = null;
  state.assistantMessageId = null;
  resetSpeechTurn();
  syncUi();

  if (!silent) {
    log("Disconnected from the Realtime session.");
  }
}

async function ensureMicrophonePipeline() {
  if (state.audioContext) {
    return;
  }

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext();
  await audioContext.resume();

  const sourceNode = audioContext.createMediaStreamSource(micStream);
  const processorNode = audioContext.createScriptProcessor(2048, 1, 1);
  const sinkNode = audioContext.createGain();
  sinkNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    handleAudioFrame(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(sinkNode);
  sinkNode.connect(audioContext.destination);

  state.micStream = micStream;
  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;
  state.sinkNode = sinkNode;
  state.audio.sampleRate = audioContext.sampleRate;

  log(`Microphone ready at ${audioContext.sampleRate}Hz.`);
}

function stopMicrophonePipeline() {
  for (const track of state.micStream?.getTracks?.() || []) {
    track.stop();
  }

  if (state.sourceNode) {
    try {
      state.sourceNode.disconnect();
    } catch {}
  }
  if (state.processorNode) {
    try {
      state.processorNode.disconnect();
    } catch {}
  }
  if (state.sinkNode) {
    try {
      state.sinkNode.disconnect();
    } catch {}
  }
  if (state.audioContext) {
    void state.audioContext.close().catch(() => {});
  }

  state.micStream = null;
  state.audioContext = null;
  state.sourceNode = null;
  state.processorNode = null;
  state.sinkNode = null;
  state.audio.micLevel = 0;
  state.audio.preRollChunks = [];
  state.audio.preRollSamples = 0;
}

function handleDataChannelOpen() {
  state.connected = true;
  state.audio.preRollChunks = [];
  state.audio.preRollSamples = 0;
  log(`Realtime data channel opened with ${MODEL} / ${VOICE}.`, "good");

  sendRealtimeEvent({
    type: "session.update",
    session: {
      type: "realtime",
      model: MODEL,
      instructions: DEFAULT_INSTRUCTIONS,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: TARGET_SAMPLE_RATE,
          },
          turn_detection: null,
        },
        output: {
          voice: VOICE,
        },
      },
    },
  });

  syncUi();
}

function handleRealtimeEvent(messageEvent) {
  let event;
  try {
    event = JSON.parse(messageEvent.data);
  } catch {
    return;
  }

  switch (event.type) {
    case "session.created":
      log("OpenAI Realtime session created.", "good");
      break;
    case "session.updated":
      log("Realtime session updated for manual turn sending.", "good");
      break;
    case "response.created":
      state.responseInProgress = true;
      ensureAssistantMessage();
      syncUi();
      break;
    case "response.output_audio_transcript.delta":
      appendAssistantDelta(event.delta || "", "audio_transcript");
      break;
    case "response.output_text.delta":
      appendAssistantDelta(event.delta || "", "text");
      break;
    case "response.done":
      state.responseInProgress = false;
      finalizeAssistantMessage();
      syncUi();
      break;
    case "response.cancelled":
      state.responseInProgress = false;
      finalizeAssistantMessage("Interrupted.");
      syncUi();
      break;
    case "error":
      state.responseInProgress = false;
      log(event.error?.message || "Realtime API error.", "bad");
      syncUi();
      break;
    default:
      break;
  }
}

function handleAudioFrame(inputFrame, sampleRate) {
  const frame = new Float32Array(inputFrame);
  const frameMs = (frame.length / sampleRate) * 1000;
  const rms = computeRms(frame);
  state.audio.micLevel = rms;

  if (!state.connected || state.dataChannel?.readyState !== "open") {
    pushPreRollFrame(frame, sampleRate);
    syncUi();
    return;
  }

  if (!state.audio.speaking) {
    if (rms >= VAD_THRESHOLD) {
      state.audio.loudMs += frameMs;
      if (state.audio.loudMs >= VAD_START_MS) {
        startSpeechTurn();
        appendSpeechFrame(frame);
        syncUi();
        return;
      }
    } else {
      state.audio.loudMs = Math.max(0, state.audio.loudMs - frameMs);
    }
    pushPreRollFrame(frame, sampleRate);
    syncUi();
    return;
  }

  appendSpeechFrame(frame);

  if (rms >= VAD_THRESHOLD * 0.72) {
    state.audio.silenceMs = 0;
  } else {
    state.audio.silenceMs += frameMs;
  }

  const turnMs = (state.audio.activeSamples / sampleRate) * 1000;
  if (state.audio.silenceMs >= VAD_STOP_MS && turnMs >= VAD_MIN_TURN_MS) {
    void flushSpeechTurn(state.audio.silenceMs);
  } else if (turnMs >= MAX_TURN_MS) {
    void flushSpeechTurn(0);
  }

  syncUi();
}

function startSpeechTurn() {
  if (state.audio.speaking) {
    return;
  }

  state.audio.speaking = true;
  state.audio.silenceMs = 0;
  state.audio.activeChunks = [];
  state.audio.activeSamples = 0;

  if (state.responseInProgress) {
    sendRealtimeEvent({ type: "response.cancel" });
    log("Cancelled the current response because new speech started.", "warn");
  }

  for (const chunk of state.audio.preRollChunks) {
    appendSpeechFrame(chunk);
  }
}

async function flushSpeechTurn(trailingSilenceMs) {
  if (!state.audio.speaking || state.audio.flushing) {
    return;
  }

  state.audio.flushing = true;

  const sampleRate = state.audio.sampleRate;
  const collected = mergeFloat32Chunks(state.audio.activeChunks, state.audio.activeSamples);
  resetSpeechTurn();

  const trimSamples = Math.min(
    collected.length,
    Math.round((sampleRate * trailingSilenceMs) / 1000),
  );
  const trimmed =
    trimSamples > 0 ? collected.subarray(0, collected.length - trimSamples) : collected;

  try {
    const minSamples = Math.round((sampleRate * VAD_MIN_TURN_MS) / 1000);
    if (trimmed.length < minSamples) {
      return;
    }

    const downsampled = downsampleBuffer(trimmed, sampleRate, TARGET_SAMPLE_RATE);
    const screenshot = state.screenStream ? captureScreenshot() : null;
    const screenshotBytes = screenshot ? estimateDataUrlBytes(screenshot) : 0;
    const audioChunkCount = Math.max(1, Math.ceil(downsampled.length / AUDIO_APPEND_CHUNK_SAMPLES));

    await sendRealtimeEventBuffered({
      type: "input_audio_buffer.clear",
    });

    if (screenshot) {
      await sendRealtimeEventBuffered({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: screenshot,
            },
          ],
        },
      });
    }

    await appendAudioInChunks(downsampled);
    await sendRealtimeEventBuffered({
      type: "input_audio_buffer.commit",
    });
    await sendRealtimeEventBuffered({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
      },
    });

    state.turnCounter += 1;
    addMessage({
      role: "user",
      text: screenshot
        ? "Voice turn sent with the current screen snapshot queued first, then chunked audio."
        : "Voice turn sent without screen sharing.",
      meta: [
        `turn ${state.turnCounter}`,
        screenshot ? "image-first" : "voice-only",
        `${audioChunkCount} audio chunks`,
        `${(downsampled.length / TARGET_SAMPLE_RATE).toFixed(1)}s`,
      ],
    });
    log(
      screenshot
        ? `Sent one screenshot first (${formatKilobytes(screenshotBytes)}), then ${audioChunkCount} audio chunks.`
        : `Sent ${audioChunkCount} audio chunks without a screenshot.`,
      "good",
    );
  } catch (error) {
    log(error.message || "Failed to send the speech turn.", "bad");
  } finally {
    state.audio.flushing = false;
    syncUi();
  }
}

async function toggleScreenShare() {
  if (!state.connected) {
    return;
  }

  if (state.screenStream) {
    stopScreenShare();
    log("Screen sharing stopped.");
    syncUi();
    return;
  }

  if (state.desktop.enabled && window.desktopBridge?.listCaptureSources) {
    await openCaptureSourceModal();
    return;
  }

  await startBrowserScreenShare();
}

function stopScreenShare() {
  for (const track of state.screenStream?.getTracks?.() || []) {
    track.stop();
  }

  state.screenStream = null;
  els.screenPreview.srcObject = null;
}

async function startBrowserScreenShare() {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 1,
      },
      audio: false,
    });

    await attachScreenStream(screenStream, "browser");
  } catch (error) {
    log(error.message || "Screen sharing was cancelled.", "warn");
  } finally {
    syncUi();
  }
}

async function openCaptureSourceModal() {
  try {
    const sources = await window.desktopBridge.listCaptureSources();
    if (!sources.length) {
      throw new Error("공유 가능한 화면을 찾지 못했습니다.");
    }

    renderCaptureSources(sources);
    els.captureSourceModal.hidden = false;
  } catch (error) {
    log(error.message || "화면 목록을 불러오지 못했습니다.", "bad");
  }
}

function closeCaptureSourceModal() {
  els.captureSourceModal.hidden = true;
  els.captureSourceList.innerHTML = "";
}

function renderCaptureSources(sources) {
  els.captureSourceList.innerHTML = "";

  for (const source of sources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-card";
    button.innerHTML = `
      <img class="source-thumbnail" src="${escapeHtml(source.thumbnailDataUrl || "")}" alt="" />
      <div class="source-title">${escapeHtml(source.name)}</div>
      <div class="source-subtitle">${escapeHtml(source.kind === "screen" ? "Entire screen" : "Window")}</div>
    `;
    button.addEventListener("click", () => {
      void startDesktopScreenShare(source.id, source.name);
    });
    els.captureSourceList.append(button);
  }
}

async function startDesktopScreenShare(sourceId, sourceName) {
  try {
    const screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 8,
        },
      },
    });

    closeCaptureSourceModal();
    await attachScreenStream(screenStream, sourceName);
  } catch (error) {
    log(error.message || "선택한 화면을 공유하지 못했습니다.", "bad");
  } finally {
    syncUi();
  }
}

async function attachScreenStream(screenStream, sourceLabel) {
  const track = screenStream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    if (state.screenStream !== screenStream) {
      return;
    }
    stopScreenShare();
    syncUi();
    log("Screen sharing ended from the user selection.", "warn");
  });

  state.screenStream = screenStream;
  els.screenPreview.srcObject = screenStream;
  await els.screenPreview.play().catch(() => {});
  log(`Screen sharing enabled: ${sourceLabel}. A single snapshot will be attached at turn end.`, "good");
}

function captureScreenshot() {
  const video = els.screenPreview;
  if (!state.screenStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return null;
  }

  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const attempts = [
    { maxWidth: 960, quality: 0.68 },
    { maxWidth: 768, quality: 0.58 },
    { maxWidth: 640, quality: 0.5 },
    { maxWidth: 512, quality: 0.42 },
  ];

  const canvas = document.createElement("canvas");
  let lastDataUrl = null;

  for (const attempt of attempts) {
    const scale = Math.min(1, attempt.maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", attempt.quality);
    lastDataUrl = dataUrl;

    if (estimateDataUrlBytes(dataUrl) <= MAX_IMAGE_BYTES) {
      return dataUrl;
    }
  }

  return lastDataUrl;
}

function sendRealtimeEvent(payload) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    throw new Error("Realtime data channel is not open yet.");
  }
  state.dataChannel.send(JSON.stringify(payload));
}

async function sendRealtimeEventBuffered(payload) {
  sendRealtimeEvent(payload);
  if (state.dataChannel.bufferedAmount > DATA_CHANNEL_HIGH_WATER_MARK) {
    await waitForBufferedAmountLow();
  }
}

function waitForBufferedAmountLow() {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    return Promise.resolve();
  }
  if (state.dataChannel.bufferedAmount <= DATA_CHANNEL_LOW_WATER_MARK) {
    return Promise.resolve();
  }

  const channel = state.dataChannel;
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER_MARK;
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(cleanup, 1500);
    const onLow = () => {
      cleanup();
    };
    const onClose = () => {
      cleanup();
    };
    const onError = () => {
      cleanup();
    };
    function cleanup() {
      window.clearTimeout(timeoutId);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
  });
}

async function appendAudioInChunks(float32Array) {
  for (let index = 0; index < float32Array.length; index += AUDIO_APPEND_CHUNK_SAMPLES) {
    const chunk = float32Array.subarray(index, index + AUDIO_APPEND_CHUNK_SAMPLES);
    await sendRealtimeEventBuffered({
      type: "input_audio_buffer.append",
      audio: encodePcm16ToBase64(chunk),
    });
  }
}

function pushPreRollFrame(chunk, sampleRate) {
  state.audio.preRollChunks.push(chunk);
  state.audio.preRollSamples += chunk.length;

  const maxSamples = Math.round((sampleRate * PRE_ROLL_MS) / 1000);
  while (state.audio.preRollSamples > maxSamples && state.audio.preRollChunks.length > 0) {
    const removed = state.audio.preRollChunks.shift();
    state.audio.preRollSamples -= removed.length;
  }
}

function appendSpeechFrame(chunk) {
  state.audio.activeChunks.push(chunk);
  state.audio.activeSamples += chunk.length;
}

function resetSpeechTurn() {
  state.audio.speaking = false;
  state.audio.loudMs = 0;
  state.audio.silenceMs = 0;
  state.audio.activeChunks = [];
  state.audio.activeSamples = 0;
}

function ensureAssistantMessage() {
  const existing = state.messages.find((message) => message.id === state.assistantMessageId);
  if (existing) {
    return existing;
  }

  const message = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    meta: ["assistant"],
    transcriptSource: null,
    pending: true,
    time: new Date(),
  };
  state.assistantMessageId = message.id;
  state.messages.push(message);
  renderMessages();
  return message;
}

function appendAssistantDelta(delta, source) {
  if (!delta) {
    return;
  }

  const message = ensureAssistantMessage();
  if (!message.transcriptSource) {
    message.transcriptSource = source;
  }
  if (message.transcriptSource !== source) {
    return;
  }

  message.text += delta;
  renderMessages();
}

function finalizeAssistantMessage(fallbackText = "Audio response received.") {
  const message = state.messages.find((item) => item.id === state.assistantMessageId);
  if (!message) {
    return;
  }

  if (!message.text.trim()) {
    message.text = fallbackText;
  }
  message.pending = false;
  state.assistantMessageId = null;
  renderMessages();
}

function addMessage(message) {
  state.messages.push({
    id: crypto.randomUUID(),
    pending: false,
    time: new Date(),
    ...message,
  });
  renderMessages();
}

function renderMessages() {
  if (state.messages.length === 0) {
    els.conversationList.innerHTML =
      '<div class="message assistant"><div class="message-header"><span>Ready</span><span>now</span></div><p class="message-text">Connect를 누르면 음성 대화가 시작되고, 화면 공유가 켜져 있으면 말 끝마다 스크린샷 1장이 함께 전송됩니다.</p></div>';
    return;
  }

  els.conversationList.innerHTML = state.messages
    .map((message) => {
      const roleLabel = message.role === "user" ? "You" : "Assistant";
      const timeLabel = message.time.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const pills = (message.meta || [])
        .map((item) => `<span class="pill">${escapeHtml(item)}</span>`)
        .join("");

      return `
        <div class="message ${message.role}">
          <div class="message-header">
            <span>${roleLabel}${message.pending ? "..." : ""}</span>
            <span>${timeLabel}</span>
          </div>
          <p class="message-text">${escapeHtml(message.text || "")}</p>
          ${pills ? `<div class="message-meta">${pills}</div>` : ""}
        </div>
      `;
    })
    .join("");

  els.conversationList.scrollTop = els.conversationList.scrollHeight;
}

function log(message, tone = "info") {
  state.logs.push({
    id: crypto.randomUUID(),
    tone,
    message,
    time: new Date(),
  });

  if (state.logs.length > 60) {
    state.logs.shift();
  }

  renderLogs();
}

function renderLogs() {
  if (state.logs.length === 0) {
    els.logList.innerHTML =
      '<div class="log-entry"><div class="log-time">--:--:--</div><div class="log-message">Waiting for the first event.</div></div>';
    return;
  }

  els.logList.innerHTML = state.logs
    .map((entry) => {
      const timeLabel = entry.time.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `
        <div class="log-entry ${entry.tone}">
          <div class="log-time">${timeLabel}</div>
          <div class="log-message">${escapeHtml(entry.message)}</div>
        </div>
      `;
    })
    .join("");

  els.logList.scrollTop = els.logList.scrollHeight;
}

function computeRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

function mergeFloat32Chunks(chunks, totalSamples) {
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return buffer;
  }
  if (inputRate < outputRate) {
    throw new Error("Input sample rate must be greater than or equal to output sample rate.");
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.round(buffer.length / ratio);
  const output = new Float32Array(outputLength);

  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * ratio);
    let sum = 0;
    let count = 0;

    for (let i = inputIndex; i < nextInputIndex && i < buffer.length; i += 1) {
      sum += buffer[i];
      count += 1;
    }

    output[outputIndex] = count > 0 ? sum / count : 0;
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return output;
}

function encodePcm16ToBase64(float32Array) {
  const arrayBuffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(arrayBuffer);

  for (let i = 0; i < float32Array.length; i += 1) {
    const value = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }

  return bytesToBase64(new Uint8Array(arrayBuffer));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

function formatKilobytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractErrorMessage(rawText) {
  try {
    const payload = JSON.parse(rawText);
    return payload.details?.error?.message || payload.error || rawText;
  } catch {
    return rawText || "Failed to create the Realtime session.";
  }
}
