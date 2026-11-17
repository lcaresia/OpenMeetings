import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { api, saveToken, UnauthorizedError } from "./api";
import { HomePage } from "./HomePage";
import { I18nContext, initialLanguage, LANGUAGES, type Language, useI18n } from "./i18n";
import { MeetingPage } from "./MeetingPage";
import { onLinkClick, usePath } from "./router";
import { SettingsPage } from "./SettingsPage";
import { Button, Card } from "./ui";

function TokenGate({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  return (
    <div className="mx-auto mt-24 max-w-sm">
      <Card title={t.tokenTitle}>
        <p className="mb-3 text-sm text-stone-500">{t.tokenHint}</p>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveToken(token.trim());
            onDone();
          }}
        >
          <input
            type="password"
            aria-label={t.token}
            className="flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit">{t.enter}</Button>
        </form>
      </Card>
    </div>
  );
}

function App() {
  const [lang, setLang] = useState<Language>(initialLanguage);
  const [authed, setAuthed] = useState<boolean>();
  const path = usePath();
  const i18n = useMemo(
    () => ({
      t: LANGUAGES[lang],
      lang,
      setLang: (next: Language) => {
        setLang(next);
        try {
          localStorage.setItem("om.lang", next);
        } catch {
          // storage blocked
        }
      },
    }),
    [lang],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the gate is passed
  useEffect(() => {
    api("/api/health").then(
      () => setAuthed(true),
      (error: unknown) => setAuthed(!(error instanceof UnauthorizedError)),
    );
  }, [authed === false]);

  useEffect(() => {
    document.documentElement.lang = lang;
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
    apply();
    dark.addEventListener("change", apply);
    return () => dark.removeEventListener("change", apply);
  }, [lang]);

  const meeting = /^\/meetings\/([^/]+)/.exec(path)?.[1];
  const t = i18n.t;

  return (
    <I18nContext.Provider value={i18n}>
      <div className="min-h-full">
        <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
            <a href="/" onClick={onLinkClick} className="flex items-center gap-2 font-semibold">
              <img src="/favicon.svg" alt="" className="h-6 w-6" />
              {t.appName}
            </a>
            <nav className="flex items-center gap-4 text-sm">
              <a
                href="/"
                onClick={onLinkClick}
                className={path === "/" ? "font-semibold" : "text-stone-600 dark:text-stone-300"}
              >
                {t.navMeetings}
              </a>
              <a
                href="/settings"
                onClick={onLinkClick}
                className={
                  path === "/settings" ? "font-semibold" : "text-stone-600 dark:text-stone-300"
                }
              >
                {t.navSettings}
              </a>
              <select
                aria-label={t.language}
                className="rounded border border-stone-300 bg-transparent px-1 py-0.5 text-xs dark:border-stone-700"
                value={lang}
                onChange={(event) => i18n.setLang(event.target.value as Language)}
              >
                <option value="pt-BR">PT</option>
                <option value="en">EN</option>
              </select>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">
          {authed === false ? (
            <TokenGate onDone={() => setAuthed(undefined)} />
          ) : authed === undefined ? null : meeting ? (
            <MeetingPage key={meeting} id={meeting} />
          ) : path === "/settings" ? (
            <SettingsPage />
          ) : (
            <HomePage />
          )}
        </main>
      </div>
    </I18nContext.Provider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
