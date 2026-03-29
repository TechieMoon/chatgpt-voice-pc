const { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODEL = "gpt-realtime-1.5";
const VOICE = "marin";
const APP_ID = "com.techiemoon.chatgpt-voice-pc";

let mainWindow = null;
let sessionApiKey = null;

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  configurePermissions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("desktop:get-api-key-state", () => getApiKeyState());

ipcMain.handle("desktop:save-api-key", (_event, payload) => {
  const apiKey = normalizeApiKey(payload?.apiKey);
  const persist = Boolean(payload?.persist);

  if (!apiKey) {
    throw new Error("OpenAI API key를 입력해주세요.");
  }

  sessionApiKey = apiKey;
  let warning = null;

  if (persist) {
    if (!safeStorage.isEncryptionAvailable()) {
      warning = "이 PC에서는 OS 암호화 저장소를 사용할 수 없어 이번 실행에만 보관합니다.";
    } else {
      writeStoredApiKey(apiKey);
    }
  }

  return {
    ...getApiKeyState(),
    warning,
  };
});

ipcMain.handle("desktop:clear-api-key", () => {
  sessionApiKey = null;
  const filePath = getCredentialsFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return getApiKeyState();
});

ipcMain.handle("desktop:create-realtime-session", async (_event, offerSdp) => {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("먼저 OpenAI API key를 설정해주세요.");
  }

  if (!offerSdp || typeof offerSdp !== "string") {
    throw new Error("Realtime SDP offer가 비어 있습니다.");
  }

  if (typeof fetch !== "function" || typeof FormData !== "function") {
    throw new Error("이 Electron 런타임에는 fetch/FormData가 없어 Realtime 세션을 만들 수 없습니다.");
  }

  const form = new FormData();
  form.set("sdp", offerSdp);
  form.set(
    "session",
    JSON.stringify({
      type: "realtime",
      model: MODEL,
      audio: {
        output: {
          voice: VOICE,
        },
      },
    }),
  );

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });
  } catch {
    throw new Error("OpenAI Realtime API에 연결하지 못했습니다.");
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(extractOpenAiError(bodyText));
  }

  return {
    sdp: bodyText,
    model: MODEL,
    voice: VOICE,
  };
});

ipcMain.handle("desktop:list-capture-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: {
      width: 360,
      height: 220,
    },
    fetchWindowIcons: true,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    displayId: source.display_id,
    thumbnailDataUrl: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon?.isEmpty?.() ? null : source.appIcon?.toDataURL?.() ?? null,
  }));
});

ipcMain.handle("desktop:get-app-meta", () => ({
  isDesktop: true,
  version: app.getVersion(),
  productName: "ChatGPT Voice PC",
}));

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(
      permission === "media" ||
        permission === "display-capture" ||
        permission === "screen-wake-lock",
    );
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return (
      permission === "media" ||
      permission === "display-capture" ||
      permission === "screen-wake-lock"
    );
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#f2eee7",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(
    process.env.ELECTRON_START_URL ||
      pathToFileURL(path.join(__dirname, "..", "public", "index.html")).toString(),
  );
}

function getCredentialsFilePath() {
  return path.join(app.getPath("userData"), "openai-key.json");
}

function getApiKeyState() {
  const storedApiKey = readStoredApiKey();
  return {
    hasKey: Boolean(sessionApiKey || storedApiKey),
    mode: sessionApiKey ? "session" : storedApiKey ? "stored" : "missing",
    canPersist: safeStorage.isEncryptionAvailable(),
  };
}

function resolveApiKey() {
  return sessionApiKey || readStoredApiKey();
}

function normalizeApiKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStoredApiKey() {
  const filePath = getCredentialsFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (payload.encoding !== "safeStorage" || !payload.ciphertext) {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    return safeStorage.decryptString(Buffer.from(payload.ciphertext, "base64"));
  } catch {
    return null;
  }
}

function writeStoredApiKey(apiKey) {
  const filePath = getCredentialsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const ciphertext = safeStorage.encryptString(apiKey);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        encoding: "safeStorage",
        ciphertext: ciphertext.toString("base64"),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function extractOpenAiError(bodyText) {
  try {
    const payload = JSON.parse(bodyText);
    return payload.error?.message || bodyText;
  } catch {
    return bodyText || "Realtime 세션 생성에 실패했습니다.";
  }
}
