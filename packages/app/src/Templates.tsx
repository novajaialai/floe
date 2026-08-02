import { useEffect, useMemo, useState } from "react";
import { getTemplates, runTemplate, saveTemplateWorkflow, type Template } from "./api";

/**
 * The template gallery. Two states only: a filterable grid, and one template
 * open with its full prompt and its inputs. Everything it shows comes from
 * /api/templates, i.e. from templates/*.yaml — the same file the CLI and the
 * generated site read, so a template can never mean two different things.
 */
export function TemplatesView({
  onLaunched,
  busy,
}: {
  onLaunched: () => void;
  busy: boolean;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Template | null>(null);

  useEffect(() => {
    void getTemplates().then((r) => {
      setTemplates(r.templates);
      setCategories(r.categories);
    });
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return templates.filter(
      (t) =>
        (cat === "all" || t.category === cat) &&
        (!needle ||
          t.name.toLowerCase().includes(needle) ||
          (t.description ?? "").toLowerCase().includes(needle) ||
          t.id.includes(needle)),
    );
  }, [templates, cat, q]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of templates) m.set(t.category ?? "", (m.get(t.category ?? "") ?? 0) + 1);
    return m;
  }, [templates]);

  if (open) return <TemplateDetail tpl={open} onBack={() => setOpen(null)} onLaunched={onLaunched} busy={busy} />;

  return (
    <div className="scroll">
      <div className="gal-head">
        <h2>Templates</h2>
        <input className="search" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="filters">
        <button className={`filter ${cat === "all" ? "on" : ""}`} onClick={() => setCat("all")}>
          all <span>{templates.length}</span>
        </button>
        {categories.map((c) => (
          <button key={c} className={`filter ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>
            {c} <span>{counts.get(c) ?? 0}</span>
          </button>
        ))}
      </div>

      {!shown.length && <div className="empty">nothing matches</div>}
      <div className="grid">
        {shown.map((t) => (
          <button className="tcard" key={t.id} onClick={() => setOpen(t)}>
            <div className="tcard-top">
              <span className="cat">{t.category}</span>
              {t.schedule && <span className="chip dim">{t.schedule}</span>}
              {!!t.requiresLogin.length && <span className="chip login">login</span>}
            </div>
            <h3>{t.name}</h3>
            <p className="desc">{t.description}</p>
            <div className="chips">
              {t.integrations.slice(0, 3).map((i) => (
                <span className="chip dim" key={i}>
                  {i}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TemplateDetail({
  tpl,
  onBack,
  onLaunched,
  busy,
}: {
  tpl: Template;
  onBack: () => void;
  onLaunched: () => void;
  busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState(tpl.id);
  const [schedule, setSchedule] = useState(tpl.schedule ?? "");
  const [maxSteps, setMaxSteps] = useState(40);
  const [headless, setHeadless] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; msg: string }>();

  const filled = tpl.inputs.every((i) => (values[i] ?? "").trim());
  // The prompt is shown as it will actually be sent: filled values substituted live.
  const preview = tpl.prompt.replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, k) => values[k]?.trim() || whole);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setNote(undefined);
    try {
      await fn();
      setNote({ kind: "ok", msg: ok });
    } catch (err: any) {
      setNote({ kind: "err", msg: err.message ?? String(err) });
    }
  };

  return (
    <div className="scroll detail">
      <button className="back" onClick={onBack}>
        ← all templates
      </button>
      <div className="tcard-top">
        <span className="cat">{tpl.category}</span>
        {tpl.schedule && <span className="chip dim">default schedule {tpl.schedule}</span>}
        {!!tpl.requiresLogin.length && <span className="chip login">needs login: {tpl.requiresLogin.join(", ")}</span>}
      </div>
      <h1>{tpl.name}</h1>
      <p className="desc big">{tpl.description}</p>
      <div className="chips">
        {tpl.integrations.map((i) => (
          <span className="chip dim" key={i}>
            {i}
          </span>
        ))}
        <span className="chip dim">{tpl.id}</span>
      </div>

      {!!tpl.inputs.length && (
        <>
          <h2>Inputs</h2>
          <div className="form">
            {tpl.inputs.map((i) => (
              <label key={i} className="field">
                <span>{i}</span>
                <input
                  value={values[i] ?? ""}
                  placeholder={`{${i}}`}
                  onChange={(e) => setValues({ ...values, [i]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </>
      )}

      <h2>Prompt</h2>
      <pre className="prompt">{preview}</pre>

      <h2>Use it</h2>
      <div className="use">
        <div className="opts">
          <label>
            steps
            <input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(+e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
            headless
          </label>
        </div>
        <button
          className="go"
          disabled={!filled || busy}
          onClick={() =>
            act(async () => {
              await runTemplate({ id: tpl.id, inputs: values, maxSteps, headless });
              onLaunched();
            }, "started")
          }
        >
          Run now
        </button>
      </div>

      <div className="save-row">
        <label className="field">
          <span>save as workflow</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>schedule (cron, blank = manual)</span>
          <input value={schedule} placeholder="0 7 * * *" onChange={(e) => setSchedule(e.target.value)} />
        </label>
        <button
          disabled={!filled}
          onClick={() =>
            act(
              () => saveTemplateWorkflow({ id: tpl.id, inputs: values, name, schedule, maxSteps, headless: true }),
              `saved workflow "${name}"`,
            )
          }
        >
          Save as workflow
        </button>
      </div>

      {!filled && <p className="note">Fill every input before running — Floe will not send a prompt with holes in it.</p>}
      {note && <div className={`banner ${note.kind === "err" ? "err" : "ok"}`}>{note.msg}</div>}

      <h2>From the terminal</h2>
      <pre className="prompt cmdline">
        {`floe run --template ${tpl.id}${tpl.inputs.map((i) => ` \\\n  --input ${i}="${values[i] || `<${i}>`}"`).join("")}`}
      </pre>
    </div>
  );
}
