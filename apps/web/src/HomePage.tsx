import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { useI18n } from "./i18n";
import { navigate, onLinkClick } from "./router";
import type { MeetingSummary, SearchHit } from "./types";
import { Button, Card, formatDate, StatusBadge, usd } from "./ui";

function SendBot() {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api<{ id: string }>("/api/meetings", {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) }),
      });
      navigate(`/meetings/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t.sendBot}>
      <p className="mb-3 text-sm text-stone-500">{t.sendBotHint}</p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          required
          type="url"
          aria-label={t.meetingLink}
          placeholder="https://meet.google.com/abc-defg-hij"
          className="flex-[2] rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-600 dark:border-stone-700"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          aria-label={t.meetingTitle}
          placeholder={t.meetingTitle}
          className="flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-600 dark:border-stone-700"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? t.sending : t.send}
        </Button>
      </form>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </Card>
  );
}

function Search() {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>();
  const [error, setError] = useState<string>();
  const run = async () => {
    if (!query.trim()) return;
    setError(undefined);
    try {
      setHits(await api<SearchHit[]>(`/api/search?q=${encodeURIComponent(query.trim())}&limit=8`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          aria-label={t.searchPlaceholder}
          placeholder={t.searchPlaceholder}
          className="flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-600 dark:border-stone-700"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="ghost">
          {t.search}
        </Button>
      </form>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {hits && hits.length === 0 ? <p className="text-sm text-stone-500">{t.noResults}</p> : null}
      {hits?.map((hit, i) => (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: hits can share a meeting
          key={i}
          href={`/meetings/${hit.meetingId}`}
          onClick={onLinkClick}
          className="block rounded-lg border border-stone-200 p-3 text-sm hover:border-brand-500 dark:border-stone-800"
        >
          <div className="mb-1 text-xs text-stone-500">
            {hit.meetingTitle ?? hit.meetingId.slice(0, 8)} ·{" "}
            {hit.date ? new Date(hit.date).toLocaleDateString(lang) : ""}
          </div>
          <p className="line-clamp-3 whitespace-pre-line">{hit.text}</p>
        </a>
      ))}
    </div>
  );
}

function Upload() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        filename: file.name,
        title: file.name.replace(/\.[^.]+$/, ""),
      });
      const res = await fetch(withToken(`/api/meetings/upload?${query}`), {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`);
      navigate(`/meetings/${body.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t.uploadTitle}>
      <p className="mb-3 text-sm text-stone-500">{t.uploadHint}</p>
      <label className="inline-flex cursor-pointer items-center rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800">
        {busy ? t.sending : t.chooseFile}
        <input
          type="file"
          accept="audio/*,video/*"
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
          }}
        />
      </label>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </Card>
  );
}

export function HomePage() {
  const { t, lang } = useI18n();
  const [meetings, setMeetings] = useState<MeetingSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = () =>
      api<MeetingSummary[]>("/api/meetings").then(setMeetings, (e: Error) => setError(e.message));
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const live = meetings?.filter((m) => m.status === "live" || m.status === "joining") ?? [];
  const past = meetings?.filter((m) => m.status !== "live" && m.status !== "joining") ?? [];

  const row = (meeting: MeetingSummary) => (
    <a
      key={meeting.id}
      href={`/meetings/${meeting.id}`}
      onClick={onLinkClick}
      className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-stone-100 dark:hover:bg-stone-800"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {meeting.title ?? meeting.state.title ?? meeting.url ?? meeting.id.slice(0, 8)}
        </div>
        <div className="text-xs text-stone-500">
          {formatDate(meeting.startedAt, lang)} · {meeting.state.decisions.length}{" "}
          {t.decisions.toLowerCase()} · {meeting.state.actionItems.length}{" "}
          {t.actionItems.toLowerCase()} · {usd(meeting.costUsd)}
        </div>
      </div>
      <StatusBadge status={meeting.status} />
    </a>
  );

  return (
    <div className="space-y-4">
      <SendBot />
      <Upload />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {live.length ? <Card title={t.liveNow}>{live.map(row)}</Card> : null}
      <Card title={t.history}>
        <div className="mb-4">
          <Search />
        </div>
        {meetings && past.length === 0 ? (
          <p className="text-sm text-stone-500">{t.noMeetings}</p>
        ) : null}
        <div className="-mx-3">{past.map(row)}</div>
      </Card>
    </div>
  );
}
