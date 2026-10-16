import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar, ToolDivider } from "../components/shell/SubBar";
import { CodeViewer, type CodeViewerHandle } from "../components/code/CodeViewer";
import { CodeOutline } from "../components/code/CodeOutline";
import { ProblemsPanel } from "../components/code/ProblemsPanel";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useCellLibrary } from "../api/cellLibrary";
import { withLibraryTypes } from "../lib/cellLibrary";
import { useSession } from "../state/session";
import { useDieCode } from "../api/codeGen";
import { Ic } from "../icons";
import { isTypingTarget } from "../lib/keyboard";

/**
 * Code phase entry. Resolves the active die (URL → session) and hands off to
 * the inner `Code` component. The placeholder state matches the other phase
 * pages so the navigation flow is consistent.
 */
export function CodePage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="Code">
        <Centered>Open a die from the Library to view its generated code.</Centered>
      </AppShell>
    );
  }
  return <Code key={dieId} dieId={dieId} />;
}

// ── Inner page ───────────────────────────────────────────────────

function Code({ dieId }: { dieId: string }) {
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  // Cells placed from the cell library resolve (and extract) through their
  // owner die's types, scaled to this die.
  const library = useCellLibrary(dieId, annotationsQ.data);
  const annotations = useMemo(
    () =>
      annotationsQ.data
        ? withLibraryTypes(annotationsQ.data, library, { usedOnly: true })
        : undefined,
    [annotationsQ.data, library]
  );

  // Module name: prefer a sanitised die name. Falls back to the id so we
  // always have something to print, even before `die` arrives.
  const moduleName = useMemo(
    () => sanitizeModuleName(die?.name ?? dieId),
    [die?.name, dieId],
  );

  const code = useDieCode(annotations, moduleName);

  // ── Page-local UI state ──────────────────────────────────────────
  const viewerRef = useRef<CodeViewerHandle | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Reset match navigation whenever the query or the document changes —
  // otherwise a stale `matchIndex` can outlive a smaller match set.
  useEffect(() => {
    setMatchIndex(0);
  }, [search]);
  useEffect(() => {
    if (matchTotal === 0) setMatchIndex(0);
    else if (matchIndex >= matchTotal) setMatchIndex(matchTotal - 1);
  }, [matchTotal, matchIndex]);

  // ── Global Cmd/Ctrl+F → focus search ─────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset the "Copied!" flash after a beat so subsequent copies feel fresh.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1100);
    return () => clearTimeout(t);
  }, [copied]);

  const goToLine = useCallback((line: number) => {
    setSelectedLine(line);
    viewerRef.current?.goToLine(line);
  }, []);

  const onCopy = useCallback(async () => {
    const text = code.data?.source;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Most likely a non-secure-context error; fall through silently.
    }
  }, [code.data?.source]);

  const onDownload = useCallback(() => {
    const text = code.data?.source;
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = code.data!.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [code.data]);

  // Advance the focused match by `delta`, wrapping at both ends. Shared by
  // the Enter/Shift+Enter keys and the prev/next buttons in the search bar.
  const stepMatch = useCallback(
    (delta: number) => {
      if (matchTotal === 0) return;
      setMatchIndex((idx) => (idx + delta + matchTotal) % matchTotal);
    },
    [matchTotal],
  );

  // ── Search input keyboard: Enter / Shift+Enter / Esc ─────────────
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSearch("");
      (e.target as HTMLInputElement).blur();
    }
  };

  // ── Status bar items ─────────────────────────────────────────────
  const statusItems = useMemo(() => {
    if (!code.data) return [die?.name ?? dieId, code.loading ? "compiling…" : "—"];
    return [
      code.data.fileName,
      `${code.data.counts.cellTypes} cell type${code.data.counts.cellTypes === 1 ? "" : "s"} · ` +
        `${code.data.counts.instances} instances · ${code.data.counts.wires} wires`,
      selectedLine ? `L${selectedLine}` : "—",
      "verilog · LRM-2005",
    ];
  }, [code.data, code.loading, die?.name, dieId, selectedLine]);

  const problemsCount = code.data?.counts.problems ?? 0;
  const errorCount = useMemo(
    () => code.data?.problems.filter((p) => p.severity === "err").length ?? 0,
    [code.data?.problems],
  );

  return (
    <AppShell
      breadcrumb={die?.name ?? "Code"}
      meta={code.data ? `code · ${code.data.fileName}` : "code"}
    >
      <SubBar
        right={
          <>
            <button
              type="button"
              className={
                "btn" + (problemsOpen ? " on" : "") + (errorCount > 0 ? " accent" : "")
              }
              title="Toggle problems panel"
              onClick={() => setProblemsOpen((v) => !v)}
              style={{ gap: 6 }}
            >
              <span
                style={{
                  display: "inline-flex",
                  color: errorCount > 0 ? "var(--err)" : "var(--warn)",
                }}
              >
                {errorCount > 0 ? Ic.err : Ic.warn}
              </span>
              {problemsCount} {problemsCount === 1 ? "problem" : "problems"}
            </button>
            <ToolDivider />
            <button
              type="button"
              className="btn"
              onClick={onCopy}
              disabled={!code.data}
              title="Copy Verilog source"
            >
              {Ic.copy}
              <span style={{ marginLeft: 4 }}>{copied ? "copied" : "copy"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={onDownload}
              disabled={!code.data}
              title="Download .v file"
            >
              {Ic.download}
              <span style={{ marginLeft: 4 }}>{code.data?.fileName ?? "download"}</span>
            </button>
            <ToolDivider />
            <SearchInput
              value={search}
              onChange={setSearch}
              onKeyDown={onSearchKey}
              onStep={stepMatch}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              matchIndex={matchIndex}
              matchTotal={matchTotal}
              inputRef={searchRef}
            />
          </>
        }
      >
        <span
          className="m"
          style={{ fontSize: 11, color: "var(--ink2)", padding: "0 8px" }}
        >
          {code.data?.fileName ?? "—"}
        </span>
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "240px 1fr",
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--l2)",
            background: "var(--card)",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {code.data ? (
            <CodeOutline
              outline={code.data.outline}
              selectedLine={selectedLine ?? undefined}
              onGoToLine={goToLine}
            />
          ) : (
            <OutlinePlaceholder loading={code.loading} error={code.error} />
          )}
        </aside>

        <section
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "var(--card)",
          }}
        >
          {code.data ? (
            <CodeViewer
              ref={viewerRef}
              source={code.data.source}
              markers={code.data.problems
                .filter((p) => p.line != null)
                .map((p) => ({ line: p.line!, severity: p.severity }))}
              selectedLine={selectedLine ?? undefined}
              onSelectLine={setSelectedLine}
              search={search}
              matchIndex={matchTotal > 0 ? matchIndex : undefined}
              onMatchTotal={setMatchTotal}
            />
          ) : (
            <ViewerPlaceholder
              loading={code.loading}
              error={code.error}
              annotationsLoading={!annotations && annotationsQ.isLoading}
            />
          )}

          {problemsOpen && code.data && (
            <ProblemsPanel
              problems={code.data.problems}
              onJump={goToLine}
              onClose={() => setProblemsOpen(false)}
            />
          )}
        </section>
      </main>

      <StatusBar items={statusItems} />

      {/* `searchFocused` is read so React keeps it controlled — it could
          drive future affordances (e.g. status bar shortcut hint). */}
      {searchFocused && null}
    </AppShell>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function SearchInput({
  value,
  onChange,
  onKeyDown,
  onStep,
  onFocus,
  onBlur,
  matchIndex,
  matchTotal,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onStep: (delta: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  matchIndex: number;
  matchTotal: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const counter =
    value.length === 0
      ? null
      : matchTotal === 0
        ? "0/0"
        : `${matchIndex + 1}/${matchTotal}`;
  const hasMatches = matchTotal > 0;
  // Keep focus in the text input when stepping via the buttons, so the user
  // can keep typing — mousedown would otherwise steal it from the field.
  const onNavMouseDown = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="input" style={{ width: 248, height: 24 }}>
      <span style={{ color: "var(--ink3)", display: "inline-flex" }}>{Ic.search}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Pass through except for Tab so users can keep typing freely.
          if (e.key !== "Tab") onKeyDown(e);
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="search in code   ⌘F"
        aria-label="search code"
      />
      {counter && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", whiteSpace: "nowrap" }}
        >
          {counter}
        </span>
      )}
      <button
        type="button"
        className="btn ghost sm"
        title="Previous match (⇧⏎)"
        aria-label="previous match"
        disabled={!hasMatches}
        onMouseDown={onNavMouseDown}
        onClick={() => onStep(-1)}
        style={{ padding: "0 2px", height: 18, display: "inline-flex" }}
      >
        <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>{Ic.caretD}</span>
      </button>
      <button
        type="button"
        className="btn ghost sm"
        title="Next match (⏎)"
        aria-label="next match"
        disabled={!hasMatches}
        onMouseDown={onNavMouseDown}
        onClick={() => onStep(1)}
        style={{ padding: "0 2px", height: 18, display: "inline-flex" }}
      >
        {Ic.caretD}
      </button>
    </div>
  );
}

function OutlinePlaceholder({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  return (
    <div
      className="m"
      style={{
        padding: "20px 16px",
        color: "var(--ink3)",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {error ? `outline unavailable: ${error}` : loading ? "loading outline…" : "no outline"}
    </div>
  );
}

function ViewerPlaceholder({
  loading,
  error,
  annotationsLoading,
}: {
  loading: boolean;
  error: string | null;
  annotationsLoading: boolean;
}) {
  let msg = "";
  if (error) msg = `code generation unavailable: ${error}`;
  else if (annotationsLoading) msg = "loading annotations…";
  else if (loading) msg = "compiling…";
  else msg = "no source";
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--card)",
        color: "var(--ink3)",
        fontSize: 12,
      }}
    >
      {msg}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/** Verilog module identifier: ASCII, alnum + underscore, never leading digit. */
function sanitizeModuleName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "die";
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

// `isTypingTarget` is imported for parity with sibling pages; the page-level
// hotkey here (⌘F) is fine inside text inputs, so we don't gate on it. Keep
// the import in case future shortcuts (Esc to close panels, etc.) need it.
void isTypingTarget;
