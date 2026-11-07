// Presents a session's identity and daemon state; must not schedule sound or invent activity.
import type { CSSProperties } from "react";
import { agentBadge, sessionTitle } from "../copy.js";
import type { LaneSignal, SessionRefView } from "../protocol.js";
import { portraitIdentity, portraitState } from "./portrait.js";

type PortraitProps = {
  session: SessionRefView;
  signal: LaneSignal | undefined;
  connected: boolean;
  queued: boolean;
  color: number;
  onOpen?: () => void;
  opening?: boolean;
  onDismiss?: () => void;
};

export function AgentPortrait({
  session,
  signal,
  connected,
  queued,
  color,
  onDismiss,
  onOpen,
  opening,
}: PortraitProps) {
  const { expression, label } = portraitState(signal, connected, queued);
  const { accessory } = portraitIdentity(session);
  const active = connected && !queued && signal?.lifecycle === "active";
  const activity = active ? Math.max(0, Math.min(1, signal.activity)) : 0;
  const struggle = active ? Math.max(0, Math.min(1, signal.struggle)) : 0;
  const inferred = connected && !queued && signal?.lifecycleConfidence === "inferred";
  const name = sessionTitle(session);
  const style = {
    "--portrait-struggle": struggle,
    "--portrait-motion-delay": `${color * -0.47}s`,
    // Extra queued sessions still need distinct colors after the six base colors are in use.
    ...(color >= 6
      ? {
          "--portrait-head": `hsl(${((color - 6) * 137.508) % 360} 38% 82%)`,
          "--portrait-phones": `hsl(${((color - 6) * 137.508) % 360} 24% 57%)`,
        }
      : {}),
  } as CSSProperties;
  return (
    <article
      className="popover-lane popover-portrait"
      aria-label={`${agentBadge(session.agent)}, ${name}, ${label}${inferred ? ", inferred" : ""}`}
      data-expression={expression}
      data-active={active}
      data-color={color}
      data-accessory={accessory}
      style={style}
    >
      {onDismiss && (
        <button
          type="button"
          className="portrait-dismiss"
          aria-label={`Hide ${name}`}
          title="Hide until it works again"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
      {onOpen && (
        <button
          type="button"
          className="portrait-open"
          aria-label={`Open ${agentBadge(session.agent)}, ${name}`}
          title={`Open ${name}`}
          disabled={opening}
          aria-busy={opening}
          onClick={onOpen}
        />
      )}
      <span className="portrait-mascot" aria-hidden="true">
        <span className="portrait-band" />
        <span className="portrait-cup left" />
        <span className="portrait-cup right" />
        <span className="portrait-face">
          <span className="portrait-brow left" />
          <span className="portrait-brow right" />
          <span className="portrait-eye left" />
          <span className="portrait-eye right" />
        </span>
        <span className="portrait-accessory" />
        <span className="portrait-mark">
          {expression === "waiting" ? "?" : expression === "done" ? "✓" : ""}
        </span>
      </span>
      <strong>{agentBadge(session.agent)}</strong>
      <span className="popover-session" title={name}>
        {name}
      </span>
      <span className="popover-lifecycle">{label}</span>
      {inferred && <span className="portrait-inferred">Inferred</span>}
      <span className="portrait-activity" aria-hidden="true" data-active={active}>
        {[0.5, 0.8, 1, 0.7, 0.4].map((weight) => (
          <span
            key={weight}
            className="portrait-activity-bar"
            style={{ height: `${2 + activity * weight * 10}px` }}
          />
        ))}
      </span>
    </article>
  );
}
