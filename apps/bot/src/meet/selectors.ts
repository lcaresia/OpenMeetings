/**
 * Every Google Meet selector lives here. Meet changes its DOM often; when the bot breaks, this
 * is the file to fix. Each entry is an ordered list: the first match wins, the rest are
 * fallbacks (usually aria-label or text based, since class names are obfuscated).
 *
 * The bot joins with `?hl=en`, so text and aria-label fallbacks are written in English.
 * Sources for every string: docs/research/2026-11-16-meet-dom-and-licenses.md.
 *
 * Two kinds of lists:
 * - `pw`: Playwright selectors (support `:has-text()`), used from Node to click and type.
 * - `css`: plain CSS, used inside the page by the injected observer.
 */
export const SELECTORS = {
  preJoin: {
    /** pw */
    nameInput: [
      'input[type="text"][aria-label="Your name"]',
      'input[type="text"][aria-label="Enter your name"]',
      'input[jsname][type="text"]',
    ],
    /** pw */
    joinButton: [
      'button:has-text("Ask to join")',
      'button:has-text("Join now")',
      'button:has-text("Ask to join anyway")',
      'button:has-text("Join anyway")',
      'button:has-text("Join here too")',
      'button:has-text("Switch here")',
    ],
    /** pw: present while the device is on; clicking turns it off. */
    micOff: ['[aria-label="Turn off microphone"]', '[aria-label^="Turn off microphone"]'],
    camOff: ['[aria-label="Turn off camera"]', '[aria-label^="Turn off camera"]'],
    /** pw: dialogs that can cover the join button. */
    dismiss: [
      'button:has-text("Continue without microphone and camera")',
      'button:has-text("Got it")',
      'button[aria-label="Close dialog"]',
      '[aria-modal="true"] button[aria-label="Close"]',
    ],
  },

  /** Phrases looked up in the page text (case-insensitive). */
  states: {
    waiting: [
      "Asking to be let in",
      "You'll join the call when someone lets you in",
      "Waiting for the host to join",
    ],
    denied: ["denied your request", "You were denied", "not allowed to join"],
    noResponse: ["No one responded to your request to join"],
    notFound: [
      "Check your meeting code",
      "Invalid video call name",
      "Your meeting code has expired",
    ],
    blocked: ["You can't join this video call"],
    ended: [
      "You've been removed from the meeting",
      "The call ended because everyone left",
      "Your host ended the meeting for everyone",
      "You left the meeting",
    ],
  },

  /** css: proof of being inside the call. The toolbar also exists in the lobby, so it is not used. */
  admitted: ["[data-self-name]", "[data-participant-id]"],

  captions: {
    /** pw */
    turnOn: [
      'button[aria-label="Turn on captions"]',
      'button[aria-label="Captions and translation"][aria-pressed="false"]',
    ],
    /** pw */
    isOn: [
      'button[aria-label="Turn off captions"]',
      'button[aria-label="Captions and translation"][aria-pressed="true"]',
    ],
    /** Keyboard shortcut that toggles captions. */
    shortcut: "c",
    /** css */
    region: ['div[role="region"][aria-label*="aption"]', 'div[role="region"][tabindex="0"]'],
  },

  chat: {
    /** pw */
    open: ['button[data-panel-id="2"]', 'button[aria-label^="Chat with everyone"]'],
    /** pw */
    input: ['textarea[aria-label="Send a message"]', 'textarea[aria-label*="message"]'],
    /** css */
    message: "[data-message-id]",
    /** css: inside a message */
    messageText: ['[jsname="dTKtvb"]'],
    /** Attribute on the message or an ancestor (a run of messages shares one header). */
    senderAttribute: "data-sender-name",
    /** Meet shows your own messages under this label. */
    selfLabels: ["You", "Você"],
  },

  participants: {
    /** css */
    tile: "[data-participant-id]",
    /** css: inside a tile */
    name: ["span.notranslate"],
    selfAttribute: "data-self-name",
    /** Tiles that are not people. */
    ignoreNames: "^Google Participant \\(|spaces/|devices/",
  },

  /** pw */
  leave: ['button[aria-label="Leave call"]', 'button[aria-label*="Leave"]'],
} as const;

export type MeetSelectors = typeof SELECTORS;

/** The subset the in-page observer needs, as plain JSON. */
export function pageSelectors() {
  return {
    captionRegion: [...SELECTORS.captions.region],
    chatMessage: SELECTORS.chat.message,
    chatText: [...SELECTORS.chat.messageText],
    senderAttribute: SELECTORS.chat.senderAttribute,
    tile: SELECTORS.participants.tile,
    tileName: [...SELECTORS.participants.name],
    selfAttribute: SELECTORS.participants.selfAttribute,
    ignoreNames: SELECTORS.participants.ignoreNames,
  };
}

export type PageSelectors = ReturnType<typeof pageSelectors>;
