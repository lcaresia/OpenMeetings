/**
 * Code that runs inside the Meet tab. Kept as plain JavaScript strings on purpose: bundlers
 * inject helpers into compiled functions, which then break once serialized into the page.
 *
 * The observer only reports raw DOM facts (caption blocks, chat messages, tiles) through the
 * `__omEmit` binding. Deduplication and timing happen in Node, where they are unit tested.
 */

/** Messages the page sends to Node. */
export type PageMessage =
  | { kind: "caption"; key: string; speaker: string; text: string }
  | { kind: "caption-removed"; key: string }
  | { kind: "chat"; id: string; sender: string; text: string }
  | { kind: "audio"; pcmBase64: string; sampleRate: number };

/** Installs MutationObservers for captions and chat. Argument: PageSelectors. */
export const OBSERVER_SCRIPT = String.raw`(selectors) => {
  if (window.__omObserver) return "already installed";
  window.__omObserver = true;
  const emit = (message) => window.__omEmit(message);
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const text = (el) => clean(el ? (el.innerText ?? el.textContent) : "");
  const first = (root, list) => {
    for (const selector of list) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {}
    }
    return null;
  };

  // A caption block is [speaker, text...] somewhere below one element. Wrappers with a single
  // child are skipped, since Meet nests the real nodes a few levels deep.
  const readBlock = (block) => {
    let node = block;
    for (let depth = 0; depth < 6; depth++) {
      const kids = [...node.children].filter((child) => text(child));
      if (kids.length === 1) node = kids[0];
      else break;
    }
    const kids = [...node.children].filter((child) => text(child));
    if (kids.length < 2) return null;
    const speaker = text(kids[0]);
    const body = kids.slice(1).map(text).join(" ");
    if (!speaker || !body || speaker.length > 60) return null;
    return { speaker, text: body };
  };

  // The container is the element whose children read best as caption blocks.
  const captionBlocks = (region) => {
    let best = [];
    const walk = (el, depth) => {
      const blocks = [...el.children].filter((child) => readBlock(child));
      if (blocks.length > best.length) best = blocks;
      if (depth < 4) for (const child of el.children) walk(child, depth + 1);
    };
    walk(region, 0);
    return best;
  };

  let counter = 0;
  const keyOf = (el) => el.dataset.omKey || (el.dataset.omKey = String(++counter));
  const shown = new Map();

  const scanCaptions = () => {
    const region = first(document, selectors.captionRegion);
    const present = new Set();
    if (region) {
      for (const block of captionBlocks(region)) {
        const read = readBlock(block);
        if (!read) continue;
        const key = keyOf(block);
        present.add(key);
        const value = read.speaker + "\u0000" + read.text;
        if (shown.get(key) === value) continue;
        shown.set(key, value);
        emit({ kind: "caption", key, speaker: read.speaker, text: read.text });
      }
    }
    for (const key of [...shown.keys()]) {
      if (present.has(key)) continue;
      shown.delete(key);
      emit({ kind: "caption-removed", key });
    }
  };

  const seenChat = new Set();
  const senderOf = (message) => {
    const holder = message.closest("[" + selectors.senderAttribute + "]");
    return clean(holder ? holder.getAttribute(selectors.senderAttribute) : "") || "unknown";
  };
  const scanChat = (silent) => {
    for (const message of document.querySelectorAll(selectors.chatMessage)) {
      const id = message.getAttribute("data-message-id");
      if (!id || seenChat.has(id)) continue;
      const body = text(first(message, selectors.chatText) || message);
      if (!body) continue;
      seenChat.add(id);
      if (!silent) emit({ kind: "chat", id, sender: senderOf(message), text: body });
    }
  };

  // Messages already on screen when we arrive are history, not commands.
  scanChat(true);
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scanCaptions();
      scanChat(false);
    }, 150);
  };
  new MutationObserver(schedule).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  schedule();
  return "installed";
}`;

/** Returns the people on screen, excluding the bot itself. Argument: PageSelectors. */
export const PARTICIPANTS_SCRIPT = String.raw`(selectors) => {
  const ignore = new RegExp(selectors.ignoreNames);
  const people = new Map();
  for (const tile of document.querySelectorAll(selectors.tile)) {
    if (tile.hasAttribute(selectors.selfAttribute)) continue;
    const id = tile.getAttribute("data-participant-id");
    let name = "";
    for (const selector of selectors.tileName) {
      const el = tile.querySelector(selector);
      if (el && el.textContent.trim()) { name = el.textContent.trim(); break; }
    }
    if (!id || !name || ignore.test(name) || people.has(id)) continue;
    people.set(id, name);
  }
  return [...people].map(([id, name]) => ({ id, name }));
}`;

/**
 * Captures the audio other participants send, mixed and resampled to 16 kHz mono PCM, in
 * one-second chunks. Installed before Meet loads, because it wraps RTCPeerConnection.
 * Experimental: needs `--autoplay-policy=no-user-gesture-required`.
 */
export const AUDIO_SCRIPT = String.raw`(() => {
  const Original = window.RTCPeerConnection;
  if (!Original || window.__omAudio) return;
  window.__omAudio = true;
  const RATE = 16000;
  let mix = null;
  const ensure = () => {
    if (mix) return mix;
    const ctx = new AudioContext({ sampleRate: RATE });
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    mix = ctx.createGain();
    mix.connect(processor);
    processor.connect(ctx.destination);
    let buffer = new Int16Array(RATE);
    let filled = 0;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        buffer[filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        if (filled === buffer.length) {
          const bytes = new Uint8Array(buffer.buffer);
          let binary = "";
          for (let j = 0; j < bytes.length; j += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
          }
          if (window.__omEmit) window.__omEmit({ kind: "audio", pcmBase64: btoa(binary), sampleRate: RATE });
          buffer = new Int16Array(RATE);
          filled = 0;
        }
      }
    };
    ctx.resume();
    return mix;
  };
  window.RTCPeerConnection = function (...args) {
    const pc = new Original(...args);
    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      const node = ensure();
      node.context.createMediaStreamSource(new MediaStream([event.track])).connect(node);
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
})();`;
