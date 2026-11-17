// Offscreen document: holds the WebSocket to the server and, when asked, the tab's audio.
// Audio goes out as 16 kHz mono PCM16 in one-second binary frames.

const RATE = 16000;
let socket;
let media;
let context;
let playback;

const status = (patch) =>
  chrome.runtime.sendMessage({ target: "background", cmd: "status", patch });

function captureUrl(server, token) {
  const url = new URL("/capture", server.replace(/^http/, "ws"));
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

async function startAudio(streamId) {
  media = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  // Capturing a tab mutes it for the user; play it back so the meeting stays audible.
  playback = new AudioContext();
  playback.createMediaStreamSource(media).connect(playback.destination);

  context = new AudioContext({ sampleRate: RATE });
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let buffer = new Int16Array(RATE);
  let filled = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      buffer[filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (filled === buffer.length) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(buffer.buffer);
        buffer = new Int16Array(RATE);
        filled = 0;
      }
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
}

function stopAudio() {
  for (const track of media?.getTracks() ?? []) track.stop();
  context?.close();
  playback?.close();
  media = undefined;
  context = undefined;
  playback = undefined;
}

async function start({ streamId, server, token, title, url }) {
  stop();
  socket = new WebSocket(captureUrl(server, token));
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: "start",
        title,
        url,
        ...(url?.includes("meet.google.com") ? { platform: "meet" } : {}),
      }),
    );
  };
  socket.onmessage = (event) => {
    const reply = JSON.parse(event.data);
    if (reply.type === "started") status({ state: "live", meetingId: reply.meetingId });
    else if (reply.type === "reply") status({ reply: reply.text });
    else if (reply.type === "ended") status({ state: "ended", reason: reply.reason });
    else if (reply.type === "error") status({ state: "error", error: reply.message });
  };
  socket.onclose = (event) => {
    stopAudio();
    if (event.code === 1006)
      status({ state: "error", error: "Could not reach the server (address or token wrong?)" });
    else status({ state: "ended" });
  };
  if (streamId) {
    try {
      await startAudio(streamId);
    } catch (error) {
      status({ state: "error", error: `Tab audio: ${error.message}` });
    }
  }
}

function stop() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
  stopAudio();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return false;
  if (message.cmd === "start") start(message);
  else if (message.cmd === "stop") stop();
  else if (message.cmd === "send" && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message.message));
  }
  return false;
});
