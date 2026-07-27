import { colors } from "@bunli/utils";

/** Glyphs carry the signal where colour cannot: prompt rows are drawn in one colour. */
export const OK = "✓";
export const WARN = "⚠";
export const PAUSED = "⏸";
export const IDLE = "○";
export const ARROW = "→";
export const BULLET = "◆";
export const SEPARATOR = " · ";

export type Tone = "ok" | "warn" | "paused" | "idle";

const TONES = {
  ok: { glyph: OK, paint: colors.green },
  warn: { glyph: WARN, paint: colors.red },
  paused: { glyph: PAUSED, paint: colors.yellow },
  idle: { glyph: IDLE, paint: colors.dim },
} as const satisfies Record<Tone, { glyph: string; paint: (text: string) => string }>;

/** `colors` already falls back to plain text when the output is piped or NO_COLOR is set. */
export const mark = (tone: Tone, text: string) => {
  const { glyph, paint } = TONES[tone];
  return paint(`${glyph} ${text}`);
};

export const label = (text: string) => colors.dim(text);

export const toneFor = (status: string): Tone => (status === "ok" ? "ok" : "warn");
