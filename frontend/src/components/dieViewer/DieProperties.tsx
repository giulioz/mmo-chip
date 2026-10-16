import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DieMetadata } from "shared";
import { cellScaleOf, libraryRatio, normalizeCellLibrary } from "shared/cellLibrary";
import { useDies, useUpdateDie } from "../../api/dies";
import type { CellLibraryView } from "../../lib/cellLibrary";
import { useDieViewerStore } from "../../state/dieViewer";

/**
 * Inspector body with nothing selected: the die's own properties — its size,
 * the cell library it belongs to (pick one another die uses, or type a new
 * name) and its scale in that library.
 */
export function DieProperties({
  die,
  library
}: {
  die: DieMetadata | undefined;
  library: CellLibraryView;
}) {
  const dies = useDies().data;
  const update = useUpdateDie();
  const setActiveTool = useDieViewerStore((s) => s.setActiveTool);

  // Every library some die uses, with how many dies are in it.
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of dies ?? []) {
      if (d.cellLibrary) counts.set(d.cellLibrary, (counts.get(d.cellLibrary) ?? 0) + 1);
    }
    return [...counts]
      .map(([name, n]) => ({ name, dies: n }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [dies]);

  if (!die) return null;
  const save = (patch: { cellLibrary?: string | null; cellScale?: number | null }) =>
    update.mutate({ dieId: die.id, patch });
  const scale = cellScaleOf(die);

  return (
    <div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
        <div className="u">Die</div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--ink)",
            marginTop: 3,
            fontFamily: "var(--mono)",
            wordBreak: "break-word"
          }}
        >
          {die.name}
        </div>
      </div>
      <Row label="size">
        {die.width.toLocaleString()}×{die.height.toLocaleString()} px
      </Row>
      <Row label="library">
        <LibraryCombobox
          value={die.cellLibrary ?? null}
          options={options}
          disabled={update.isPending}
          onCommit={(name) => save({ cellLibrary: name })}
        />
      </Row>
      <Row label="scale">
        <ScaleField value={scale} disabled={update.isPending} onCommit={(v) => save({ cellScale: v })} />
      </Row>
      {update.error && (
        <div className="m" style={{ padding: "4px 12px", fontSize: 10.5, color: "var(--err)" }}>
          {update.error.message}
        </div>
      )}

      {library.name && (
        <>
          <div
            style={{
              padding: "6px 12px",
              marginTop: 6,
              borderTop: "1px solid var(--l1)",
              borderBottom: "1px solid var(--l1)",
              background: "var(--panel)"
            }}
          >
            <span className="u">Other dies in {library.name}</span>
          </div>
          {library.peers.length === 0 && (
            <Hint>No other die uses this library yet — pick it on another die to share cell types.</Hint>
          )}
          {library.peers.map((p) => {
            const ann = library.annotations.get(p.id);
            const types = ann?.cellTypes.filter((t) => t.matched === true).length;
            const ratio = libraryRatio(die, p);
            return (
              <div
                key={p.id}
                className="row"
                style={{ gap: 6, padding: "4px 12px", alignItems: "center" }}
                title={`${p.name} — its cells show here ${ratio.toFixed(4)}× their size there`}
              >
                <span
                  className="m"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 10.5,
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {p.name}
                </span>
                <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>
                  {types === undefined ? "…" : `${types} type${types === 1 ? "" : "s"}`}
                </span>
                <span className="m" style={{ fontSize: 10, color: "var(--ink2)", width: 52, textAlign: "right" }}>
                  ×{ratio.toFixed(3)}
                </span>
              </div>
            );
          })}
          <Hint>
            Their cell types are offered in Merge cells, RE cell and cell detection. To set this
            die's scale, place one of their cells with{" "}
            <button
              type="button"
              className="btn ghost"
              style={{ height: 18, padding: "0 4px", fontSize: 10.5, display: "inline-flex" }}
              onClick={() => setActiveTool("libraryCell")}
            >
              Place library cell
            </button>{" "}
            in the toolbar.
          </Hint>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="lbl">{label}</span>
      <span className="val" style={{ minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="m" style={{ padding: "6px 12px", fontSize: 10.5, color: "var(--ink3)", lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

type ComboRow =
  | { kind: "create"; name: string }
  | { kind: "pick"; name: string; dies: number }
  | { kind: "none" };

/**
 * Free-text dropdown: lists every library the dies use (filtered by what's
 * typed) plus "Create …" for a new name. Enter or a click commits; Escape or
 * leaving the field reverts.
 */
function LibraryCombobox({
  value,
  options,
  disabled,
  onCommit
}: {
  value: string | null;
  options: Array<{ name: string; dies: number }>;
  disabled?: boolean;
  onCommit: (name: string | null) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  // Typed since focusing: filter the list (untouched ⇒ show everything).
  const [dirty, setDirty] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value ?? ""), [value]);

  const typed = normalizeCellLibrary(text);
  const query = dirty ? text.trim().toLowerCase() : "";
  const rows: ComboRow[] = [];
  if (dirty && typed && !options.some((o) => o.name === typed)) rows.push({ kind: "create", name: typed });
  for (const o of options) {
    if (!query || o.name.toLowerCase().includes(query)) rows.push({ kind: "pick", ...o });
  }
  if (value) rows.push({ kind: "none" });

  const close = () => {
    setOpen(false);
    setDirty(false);
    setActive(0);
  };
  const commit = (row: ComboRow | undefined) => {
    const next = row ? (row.kind === "none" ? null : row.name) : typed;
    close();
    setText(next ?? "");
    if (next !== value) onCommit(next);
    inputRef.current?.blur();
  };

  return (
    <span style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
      <label className="input" style={{ flex: 1 }}>
        <input
          ref={inputRef}
          value={text}
          disabled={disabled}
          spellCheck={false}
          placeholder="none — type to create"
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => {
            close();
            setText(value ?? "");
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (rows.length ? (i + step + rows.length) % rows.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(open && rows.length ? rows[Math.min(active, rows.length - 1)] : undefined);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
              setText(value ?? "");
              inputRef.current?.blur();
            }
          }}
        />
      </label>
      {open && rows.length > 0 && (
        <div
          className="popover"
          style={{
            position: "absolute",
            top: "calc(100% + 3px)",
            left: 0,
            right: 0,
            zIndex: 30,
            maxHeight: 220,
            overflowY: "auto",
            padding: 3
          }}
          // Keep focus in the input so its blur doesn't cancel the click.
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.map((row, i) => (
            <div
              key={row.kind === "none" ? "\u0000none" : `${row.kind}:${row.name}`}
              className="m"
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(row)}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: "4px 6px",
                borderRadius: 3,
                cursor: "pointer",
                fontSize: 11,
                color: row.kind === "none" ? "var(--ink3)" : "var(--ink)",
                background: i === active ? "var(--accentBg)" : "transparent"
              }}
            >
              {row.kind === "create" ? (
                <span>
                  Create <b>“{row.name}”</b>
                </span>
              ) : row.kind === "none" ? (
                <span>No library</span>
              ) : (
                <>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.name}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink3)" }}>
                    {row.dies} die{row.dies === 1 ? "" : "s"}
                  </span>
                  {row.name === value && <span style={{ color: "var(--accent)" }}>✓</span>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Numeric field for the die's scale (pixels per library unit); commits on
 *  Enter / blur, reverts on Escape or a non-positive number. */
function ScaleField({
  value,
  disabled,
  onCommit
}: {
  value: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const shown = formatScale(value);
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value.trim().replace(/^×/, ""));
    if (!Number.isFinite(v) || v <= 0 || formatScale(v) === shown) {
      el.value = shown;
      return;
    }
    onCommit(v);
  };
  return (
    <span className="row" style={{ gap: 6, flex: 1, minWidth: 0, alignItems: "center" }}>
      <label className="input" style={{ width: 92 }}>
        <input
          key={shown}
          defaultValue={shown}
          disabled={disabled}
          inputMode="decimal"
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.currentTarget.value = shown;
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <span className="m" style={{ fontSize: 10, color: "var(--ink3)", whiteSpace: "nowrap" }}>
        px / library unit
      </span>
    </span>
  );
}

const formatScale = (v: number) => String(Number(v.toFixed(5)));
