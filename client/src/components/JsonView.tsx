import { Fragment, type ReactNode } from "react";

/**
 * A read-only, token-highlighted JSON pretty-printer for the event drawer — keys, strings, numbers,
 * booleans and null each get their own colour so a payload can be *scanned* rather than parsed by
 * eye. No dependency, no `dangerouslySetInnerHTML`: the value is walked and emitted as nested spans,
 * so a string that happens to contain `</span>` colours as a string, not as markup.
 *
 * TAKES A VALUE OR A RAW STRING. `usage_events.extra` is stored as the exact canonical JSON *bytes*
 * the node hashed (see centralMigrations.js — TEXT, not JSONB, on purpose), so a caller usually
 * hands us that string. We parse it for highlighting; if it will not parse — a truncated or
 * non-JSON payload — we show the raw text verbatim rather than throwing, because on a governance
 * dashboard "here is the unparseable thing central stored" is the honest answer.
 */

function Punct({ children }: { children: ReactNode }) {
  return <span className="jv-punct">{children}</span>;
}

function Scalar({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="jv-null">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="jv-string">"{escapeString(value)}"</span>;
    case "number":
      return <span className="jv-number">{String(value)}</span>;
    case "boolean":
      return <span className="jv-boolean">{String(value)}</span>;
    default:
      // undefined, function, symbol — never valid JSON, shown so it is not silently dropped.
      return <span className="jv-null">{String(value)}</span>;
  }
}

// JSON string escaping for display — the value came out of JSON.parse, so quotes and backslashes
// inside it must be re-escaped to read as the source did.
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

function Node({ value, indent }: { value: unknown; indent: number }): ReactNode {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return <Punct>[]</Punct>;
    return (
      <>
        <Punct>[</Punct>
        {"\n"}
        {value.map((item, i) => (
          <Fragment key={i}>
            {padInner}
            <Node value={item} indent={indent + 1} />
            {i < value.length - 1 ? <Punct>,</Punct> : null}
            {"\n"}
          </Fragment>
        ))}
        {pad}
        <Punct>]</Punct>
      </>
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Punct>{"{}"}</Punct>;
    return (
      <>
        <Punct>{"{"}</Punct>
        {"\n"}
        {entries.map(([key, val], i) => (
          <Fragment key={key}>
            {padInner}
            <span className="jv-key">"{escapeString(key)}"</span>
            <Punct>: </Punct>
            <Node value={val} indent={indent + 1} />
            {i < entries.length - 1 ? <Punct>,</Punct> : null}
            {"\n"}
          </Fragment>
        ))}
        {pad}
        <Punct>{"}"}</Punct>
      </>
    );
  }

  return <Scalar value={value} />;
}

export function JsonView({ value, source }: { value?: unknown; source?: string | null }) {
  // A raw string source is parsed for highlighting; unparseable text is shown verbatim.
  let parsed: unknown = value;
  let raw: string | null = null;
  if (source !== undefined) {
    if (source === null || source === "") {
      return <div className="jv-empty">No payload recorded.</div>;
    }
    try {
      parsed = JSON.parse(source);
    } catch {
      raw = source;
    }
  }

  if (raw !== null) {
    return (
      <pre className="jsonview jsonview-raw" aria-label="Raw payload (not valid JSON)">
        {raw}
      </pre>
    );
  }

  return (
    <pre className="jsonview" aria-label="JSON payload">
      <Node value={parsed} indent={0} />
    </pre>
  );
}
