import { useEffect, useRef } from "react";
import type { RunEvent } from "./api";

const GLYPH: Record<string, string> = {
  start: "◆",
  workspace: "▤",
  thought: "◇",
  tool_call: "▸",
  tool_result: "·",
  done: "✔",
  error: "✖",
  paused: "⏸",
  resumed: "▶",
  control: "⦿",
  end: "■",
  fatal: "✖",
  exit: "□",
  log: "·",
};

/** Streaming event tape. Auto-scrolls, but yields the moment the user scrolls up. */
export function Timeline({ events }: { events: RunEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  if (!events.length)
    return (
      <div className="tape empty-tape">
        <p>No run yet. Type a task above — Floe opens a real Chrome window and works in it.</p>
      </div>
    );

  return (
    <div className="tape" ref={box} onScroll={onScroll}>
      {events.map((e) => {
        const text = e.detail ?? e.summary ?? e.msg ?? e.dir ?? e.error ?? e.state ?? e.task ?? "";
        return (
          <div className={`row ${e.ev}`} key={e.seq}>
            <span className="g">{GLYPH[e.ev] ?? "·"}</span>
            <span className="t">{new Date(e.ts).toTimeString().slice(0, 8)}</span>
            <span className="who">
              {e.agent ?? "floe"}
              {e.step ? <em>:{e.step}</em> : null}
            </span>
            <span className="d">
              <b className="kind">{e.ev}</b>
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
