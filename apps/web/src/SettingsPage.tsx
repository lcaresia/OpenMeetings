import { useEffect, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { Button, Card, usd } from "./ui";

type Check = {
  name: string;
  target: string;
  status: "ok" | "fail" | "skipped";
  latencyMs?: number;
  detail: string;
};
type Report = {
  profile: string;
  localOnly: boolean;
  checks: Check[];
  cost: { totalUsd?: number; unpricedModels: string[] };
  ok: boolean;
};

export function SettingsPage() {
  const { t } = useI18n();
  const [config, setConfig] = useState<unknown>();
  const [report, setReport] = useState<Report>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api("/api/config").then(setConfig, (e: Error) => setError(e.message));
  }, []);

  const doctor = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setReport(await api<Report>("/api/doctor"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const mark = { ok: "text-emerald-600", fail: "text-red-600", skipped: "text-stone-400" };
  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <Card
        title="om doctor"
        actions={
          <Button onClick={() => void doctor()} disabled={running}>
            {running ? t.doctorRunning : t.runDoctor}
          </Button>
        }
      >
        {report ? (
          <div className="space-y-3 text-sm">
            <table className="w-full text-left">
              <tbody>
                {report.checks.map((check) => (
                  <tr key={check.name} className="border-b border-stone-100 dark:border-stone-800">
                    <td className={`py-1.5 pr-3 font-medium ${mark[check.status]}`}>
                      {check.status}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{check.name}</td>
                    <td className="py-1.5 pr-3 text-stone-500">{check.target}</td>
                    <td className="py-1.5">
                      {check.detail}
                      {check.latencyMs !== undefined ? (
                        <span className="text-stone-500"> ({check.latencyMs} ms)</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              {t.cost} / h:{" "}
              <strong>
                {report.cost.totalUsd === undefined ? "?" : usd(report.cost.totalUsd)}
              </strong>
              {report.cost.unpricedModels.length ? (
                <span className="text-stone-500"> ({report.cost.unpricedModels.join(", ")})</span>
              ) : null}
            </p>
          </div>
        ) : null}
      </Card>
      <Card title={t.activeConfig}>
        <pre className="max-h-[60vh] overflow-auto text-xs">
          {config ? JSON.stringify(config, null, 2) : "..."}
        </pre>
      </Card>
    </div>
  );
}
