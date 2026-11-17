import { useEffect, useRef, useState } from "react";
import { ArtifactView, DocView } from "./ArtifactView";
import { api, withToken } from "./api";
import { useI18n } from "./i18n";
import { navigate } from "./router";
import type { Segment } from "./types";
import { Button, Card, clock, StatusBadge, usd } from "./ui";
import { useMeeting } from "./useMeeting";

function Transcript({ segments, focus }: { segments: Segment[]; focus?: string }) {
  const { t } = useI18n();
  const follow = useRef(true);
  const box = useRef<HTMLDivElement>(null);

  const count = segments.length;
  const lastText = segments.at(-1)?.text;
  useEffect(() => {
    // Follows new lines (and partial captions growing) unless the reader scrolled up.
    if (count && lastText !== undefined && follow.current && !focus) {
      // Scroll the transcript box only; scrollIntoView would move the whole page too.
      const el = box.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [count, lastText, focus]);
  useEffect(() => {
    if (!focus) return;
    document
      .getElementById(`seg-${focus}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);

  if (segments.length === 0) return <p className="text-sm text-stone-500">{t.waitingSpeech}</p>;
  return (
    <div
      ref={box}
      className="max-h-[60vh] space-y-3 overflow-y-auto pr-2"
      onScroll={(event) => {
        const el = event.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {segments.map((segment) => (
        <div
          key={`${segment.id}-${segment.id === focus ? "focus" : ""}`}
          id={`seg-${segment.id}`}
          className={`rounded-md px-2 py-1 ${segment.id === focus ? "flash" : ""} ${segment.partial ? "opacity-60" : ""}`}
        >
          <div className="flex items-baseline gap-2 text-xs text-stone-500">
            <span className="font-semibold text-stone-700 dark:text-stone-300">
              {segment.speaker}
            </span>
            <span className="tabular-nums">{clock(segment.startMs)}</span>
          </div>
          <p className="text-[15px] leading-relaxed">{segment.text}</p>
        </div>
      ))}
    </div>
  );
}

function Cited({ ids, onFocus }: { ids: string[]; onFocus: (id: string) => void }) {
  const { t } = useI18n();
  const [first] = ids;
  if (!first) return null;
  return (
    <button
      type="button"
      className="ml-1 text-xs text-brand-700 hover:underline dark:text-brand-500"
      onClick={() => onFocus(first)}
    >
      {t.goToQuote}
    </button>
  );
}

export function MeetingPage({ id }: { id: string }) {
  const { t } = useI18n();
  const { view, ask, answer } = useMeeting(id);
  const [focus, setFocus] = useState<string>();
  const [tab, setTab] = useState<string>("transcript");
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const { state } = view;
  const live = view.status === "live" || view.status === "joining" || view.status === "paused";

  useEffect(() => {
    if (!focus) return;
    setTab("transcript");
    // The highlight is a moment, not a mode: afterwards the transcript follows new lines again
    // (unless the reader stays scrolled up).
    const timer = setTimeout(() => setFocus(undefined), 2500);
    return () => clearTimeout(timer);
  }, [focus]);

  const submit = async () => {
    const text = command.trim();
    if (!text) return;
    setSending(true);
    setCommand("");
    try {
      await ask(text);
    } finally {
      setSending(false);
    }
  };

  const tabs = [
    { id: "transcript", label: t.transcript },
    ...state.artifacts.map((artifact) => ({
      id: artifact.id,
      label: artifact.title ?? artifact.type,
    })),
    ...(view.minutes || !live ? [{ id: "minutes", label: t.minutes }] : []),
  ];
  const artifact = state.artifacts.find((item) => item.id === tab);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">
              {state.title ?? view.meeting?.title ?? view.meeting?.url ?? id.slice(0, 8)}
            </h1>
            <StatusBadge status={view.status} />
          </div>
          <p className="mt-1 text-sm text-stone-500">
            {state.participants.map((p) => (
              <span key={p.id} className="mr-2">
                {p.name}
                {p.external ? (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                    {t.externalBadge}
                  </span>
                ) : null}
              </span>
            ))}
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="tabular-nums text-stone-600 dark:text-stone-300" title={t.cost}>
            {t.cost}: <strong>{usd(view.costUsd)}</strong>
          </span>
          {view.latencyMs !== undefined ? (
            <span className="tabular-nums text-stone-600 dark:text-stone-300" title={t.latency}>
              {t.latency}: <strong>{(view.latencyMs / 1000).toFixed(1)} s</strong>
            </span>
          ) : null}
          {live ? (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(t.leaveConfirm))
                  void api(`/api/meetings/${id}/leave`, { method: "POST" });
              }}
            >
              {t.leave}
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(t.deleteConfirm))
                  void api(`/api/meetings/${id}`, { method: "DELETE" }).then(() => navigate("/"));
              }}
            >
              {t.deleteMeeting}
            </Button>
          )}
        </div>
      </div>

      {!view.connected && live ? (
        <p className="text-sm text-amber-700">{t.connectionLost}</p>
      ) : null}
      {view.error ? <p className="text-sm text-red-600">{view.error}</p> : null}

      {view.approvals.map((approval) => (
        <div
          key={approval.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950"
        >
          <div>
            <p className="text-sm font-semibold">{t.approvalTitle}</p>
            <p className="text-sm">{approval.summary}</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void answer(approval.id, true)}>{t.approve}</Button>
            <Button variant="ghost" onClick={() => void answer(approval.id, false)}>
              {t.deny}
            </Button>
          </div>
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Card>
            <nav className="-mt-1 mb-3 flex gap-1 overflow-x-auto border-b border-stone-100 pb-2 dark:border-stone-800">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`whitespace-nowrap rounded-md px-3 py-1 text-sm ${
                    tab === item.id
                      ? "bg-brand-700 text-white"
                      : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            {tab === "transcript" ? (
              <Transcript segments={view.segments} {...(focus ? { focus } : {})} />
            ) : null}
            {artifact ? <ArtifactView key={artifact.id} refInfo={artifact} /> : null}
            {tab === "minutes" ? (
              view.minutes ? (
                <div className="space-y-3">
                  <a className="text-xs underline" href={withToken(`/api/meetings/${id}/minutes`)}>
                    {t.exportMd}
                  </a>
                  <DocView markdown={view.minutes} />
                </div>
              ) : (
                <p className="text-sm text-stone-500">{t.minutesPending}</p>
              )
            ) : null}
          </Card>

          {live ? (
            <Card title={t.conversation}>
              <div className="mb-3 max-h-64 space-y-2 overflow-y-auto">
                {view.messages.map((message) => (
                  <div
                    key={message.id}
                    className="rounded-lg bg-brand-50 px-3 py-2 text-sm whitespace-pre-wrap dark:bg-stone-800"
                  >
                    {message.text}
                  </div>
                ))}
                {view.agentBusy > 0 || sending ? (
                  <p className="text-sm text-stone-500">{t.agentWorking}</p>
                ) : null}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <input
                  className="flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-600 dark:border-stone-700"
                  placeholder={t.commandPlaceholder}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
                <Button type="submit" disabled={!command.trim()}>
                  {t.ask}
                </Button>
              </form>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-4">
          <Card title={`${t.decisions} (${state.decisions.length})`}>
            {state.decisions.length === 0 ? (
              <p className="text-sm text-stone-500">{t.none}</p>
            ) : null}
            <ul className="space-y-2 text-sm">
              {state.decisions.map((decision) => (
                <li key={decision.id}>
                  {decision.text}
                  {decision.by ? <span className="text-stone-500"> · {decision.by}</span> : null}
                  <Cited ids={decision.sourceSegmentIds} onFocus={setFocus} />
                </li>
              ))}
            </ul>
          </Card>
          <Card title={`${t.actionItems} (${state.actionItems.length})`}>
            {state.actionItems.length === 0 ? (
              <p className="text-sm text-stone-500">{t.none}</p>
            ) : null}
            <ul className="space-y-2 text-sm">
              {state.actionItems.map((item) => (
                <li
                  key={item.id}
                  className={item.status === "done" ? "text-stone-400 line-through" : ""}
                >
                  {item.text}
                  <div className="text-xs text-stone-500">
                    {item.owner ? `${t.owner}: ${item.owner}` : null}
                    {item.owner && item.due ? " · " : null}
                    {item.due ? `${t.due}: ${item.due}` : null}
                    <Cited ids={item.sourceSegmentIds} onFocus={setFocus} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={`${t.openQuestions} (${state.openQuestions.length})`}>
            {state.openQuestions.length === 0 ? (
              <p className="text-sm text-stone-500">{t.none}</p>
            ) : null}
            <ul className="space-y-2 text-sm">
              {state.openQuestions.map((question) => (
                <li key={question.id}>
                  {question.text}
                  <Cited ids={question.sourceSegmentIds} onFocus={setFocus} />
                </li>
              ))}
            </ul>
          </Card>
          {state.rollingSummary ? (
            <Card title={t.summary}>
              <p className="text-sm leading-relaxed">{state.rollingSummary}</p>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
