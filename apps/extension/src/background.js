// Open Meetings extension, service worker. Routes between the popup, the Meet tab (captions)
// and the offscreen document, which holds the WebSocket and the tab audio.

const OFFSCREEN = "offscreen.html";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification: "Capture the meeting tab's audio and stream it to the Open Meetings server.",
  });
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.session.get("status");
  await chrome.storage.session.set({ status: { ...status, ...patch } });
}

/**
 * Starts a capture of `tabId`. With `audio`, the tab's sound is captured too (needs the user to
 * have clicked the extension on that tab). On Meet the captions are read from the page as well.
 */
async function startCapture({ tabId, audio = true, title }) {
  const { server, token } = await chrome.storage.local.get(["server", "token"]);
  if (!server) throw new Error("Set the server address first.");
  const tab = await chrome.tabs.get(tabId);
  const streamId = audio
    ? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    : undefined;
  await ensureOffscreen();
  await chrome.storage.session.set({
    status: { state: "starting", tabId, url: tab.url, server, meetingId: undefined, replies: [] },
  });
  await chrome.runtime.sendMessage({
    target: "offscreen",
    cmd: "start",
    streamId,
    server,
    token,
    title: title || tab.title,
    url: tab.url,
  });
  // On Meet, start reading captions (and chat) from the page.
  chrome.tabs.sendMessage(tabId, { target: "page", cmd: "observe" }).catch(() => undefined);
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" }).catch(() => undefined);
  const { status } = await chrome.storage.session.get("status");
  if (status?.tabId)
    chrome.tabs
      .sendMessage(status.tabId, { target: "page", cmd: "unobserve" })
      .catch(() => undefined);
}

// Exposed for automated tests (they cannot click the toolbar button).
globalThis.omStart = startCapture;
globalThis.omStop = stopCapture;

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target === "background" && message.cmd === "start") {
    startCapture(message).then(
      () => reply({ ok: true }),
      (error) => reply({ ok: false, error: String(error?.message ?? error) }),
    );
    return true;
  }
  if (message.target === "background" && message.cmd === "stop") {
    stopCapture().then(() => reply({ ok: true }));
    return true;
  }
  // Captions and chat from the Meet tab go to the offscreen document's socket.
  if (message.target === "background" && message.cmd === "page" && sender.tab) {
    chrome.runtime
      .sendMessage({ target: "offscreen", cmd: "send", message: message.message })
      .catch(() => undefined);
    return false;
  }
  if (message.target === "background" && message.cmd === "status") {
    if (message.patch.reply) {
      chrome.storage.session.get("status").then(({ status = {} }) =>
        chrome.storage.session.set({
          status: {
            ...status,
            replies: [...(status.replies ?? []).slice(-9), message.patch.reply],
          },
        }),
      );
    } else {
      setStatus(message.patch);
    }
    return false;
  }
  return false;
});
