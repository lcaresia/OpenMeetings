const $ = (id) => document.getElementById(id);

async function render() {
  const { status = {} } = await chrome.storage.session.get("status");
  const live = status.state === "live" || status.state === "starting";
  $("toggle").textContent = live ? "Stop capturing" : "Capture this tab";
  $("toggle").className = live ? "stop" : "";
  const panel =
    status.meetingId && status.server
      ? `${status.server.replace(/\/$/, "")}/meetings/${status.meetingId}`
      : "";
  const text =
    {
      starting: "Connecting...",
      live: "Capturing.",
      ended: `Stopped.${status.reason ? ` ${status.reason}` : ""}`,
      error: `Error: ${status.error ?? "unknown"}`,
    }[status.state] ?? "Not capturing.";
  $("status").innerHTML = "";
  $("status").append(text);
  if (panel) {
    const link = document.createElement("a");
    link.href = panel;
    link.target = "_blank";
    link.textContent = " Open the panel";
    $("status").append(link);
  }
  $("replies").replaceChildren(
    ...(status.replies ?? []).map((reply) => {
      const div = document.createElement("div");
      div.textContent = reply;
      return div;
    }),
  );
}

async function init() {
  const { server = "http://localhost:4319", token = "" } = await chrome.storage.local.get([
    "server",
    "token",
  ]);
  $("server").value = server;
  $("token").value = token;
  for (const id of ["server", "token"]) {
    $(id).addEventListener("change", () => chrome.storage.local.set({ [id]: $(id).value.trim() }));
  }
  $("toggle").addEventListener("click", async () => {
    await chrome.storage.local.set({
      server: $("server").value.trim(),
      token: $("token").value.trim(),
    });
    const { status = {} } = await chrome.storage.session.get("status");
    if (status.state === "live" || status.state === "starting") {
      await chrome.runtime.sendMessage({ target: "background", cmd: "stop" });
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({
      target: "background",
      cmd: "start",
      tabId: tab.id,
      title: $("title").value.trim(),
    });
    if (!result?.ok) {
      await chrome.storage.session.set({ status: { state: "error", error: result?.error } });
    }
  });
  chrome.storage.session.onChanged.addListener(render);
  render();
}

init();
