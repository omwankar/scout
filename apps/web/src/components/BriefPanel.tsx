"use client";

import { useState } from "react";
import { briefToMarkdown, type CompetitiveBrief } from "@scout/shared";
import { downloadBriefPdf } from "@/lib/briefPdf";

export function BriefPanel({
  brief,
  runComplete,
  writing,
}: {
  brief: CompetitiveBrief | null;
  runComplete?: boolean;
  writing?: boolean;
}) {
  const [pdfBusy, setPdfBusy] = useState(false);

  const copyMarkdown = async () => {
    if (!brief) return;
    await navigator.clipboard.writeText(briefToMarkdown(brief));
  };

  const copyJson = async () => {
    if (!brief) return;
    await navigator.clipboard.writeText(JSON.stringify(brief, null, 2));
  };

  const onDownloadPdf = async () => {
    if (!brief || pdfBusy) return;
    setPdfBusy(true);
    try {
      await downloadBriefPdf(brief);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "PDF export failed");
    } finally {
      setPdfBusy(false);
    }
  };

  const names = brief
    ? Array.from(
        new Set(brief.comparisonTable.flatMap((row) => Object.keys(row.values)))
      )
    : [];

  return (
    <div className="results-panel">
      <div className="results-header">
        <div>
          <h2>Competitive brief</h2>
          <p className="results-sub mono">
            {brief
              ? "overview · subjects · sources"
              : writing
                ? "writing brief…"
                : runComplete
                  ? "run finished"
                  : "waiting for findings"}
          </p>
        </div>
        <div className="results-actions">
          <button
            className="btn-export"
            type="button"
            onClick={onDownloadPdf}
            disabled={!brief || pdfBusy}
            title="Download a structured PDF of this brief"
          >
            {pdfBusy ? "PDF…" : "Download PDF"}
          </button>
          <button
            className="btn-export"
            type="button"
            onClick={copyMarkdown}
            disabled={!brief}
          >
            Copy MD
          </button>
          <button
            className="btn-export"
            type="button"
            onClick={copyJson}
            disabled={!brief}
          >
            Copy JSON
          </button>
        </div>
      </div>

      <div className="results-body">
        {!brief ? (
          <div className="results-empty">
            {writing ? (
              <>
                <div className="spin" />
                <p className="mono accent">Composing competitive brief…</p>
                <p>Formatting findings from pages visited.</p>
              </>
            ) : (
              <p>The research brief will appear here when the run finishes.</p>
            )}
          </div>
        ) : (
          <div className="report-card">
            <header className="report-hero">
              <div className="report-card-head">
                <h3 className="mono accent">Report</h3>
                <span className="confidence-pill mono">{brief.confidence}</span>
              </div>
              <h4 className="report-title">{brief.title}</h4>
              <p className="report-summary">{brief.executiveSummary}</p>
            </header>

            <section className="report-section">
              <h5 className="mono">Subjects</h5>
              <div className="subject-grid">
                {brief.subjects.map((s) => (
                  <article key={s.name} className="subject-card">
                    <h6>{s.name}</h6>
                    {s.website && (
                      <a
                        className="mono subject-url"
                        href={s.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.website.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                    <p>{s.positioning}</p>
                    {s.pricing && (
                      <p>
                        <span className="field-label mono">Pricing</span> {s.pricing}
                      </p>
                    )}
                    {!!s.strengths.length && (
                      <ul>
                        {s.strengths.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                    {!!s.weaknesses.length && (
                      <ul>
                        {s.weaknesses.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
            </section>

            {!!brief.comparisonTable.length && (
              <section className="report-section">
                <h5 className="mono">Comparison</h5>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Dimension</th>
                        {names.map((n) => (
                          <th key={n}>{n}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {brief.comparisonTable.map((row) => (
                        <tr key={row.dimension}>
                          <td>{row.dimension}</td>
                          {names.map((n) => (
                            <td key={n}>{row.values[n] ?? "—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {!!brief.recommendations.length && (
              <section className="report-section">
                <h5 className="mono">Recommendations</h5>
                <ol>
                  {brief.recommendations.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ol>
              </section>
            )}

            {!!brief.sources.length && (
              <section className="report-section">
                <h5 className="mono">Sources</h5>
                <ul className="source-list">
                  {brief.sources.map((s) => (
                    <li key={`${s.url}-${s.title}`}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                      <span className="mono source-url">{s.url}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!!brief.limitations.length && (
              <section className="report-section">
                <h5 className="mono">Limitations</h5>
                <ul>
                  {brief.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
