export interface ReactiveFlags {
  mode: 'off' | 'shadow' | 'on';
  percent: number;
}

/** Explicit input keeps secrets and environment access out of shared client modules. */
export function parseReactiveFlags(env: Readonly<Record<string, string | undefined>>): ReactiveFlags {
  const mode = env.REACTIVE_MD_MODE;
  const rawPercent = env.REACTIVE_MD_PERCENT;
  const percent = rawPercent !== undefined && /^\d{1,3}$/.test(rawPercent) ? Number(rawPercent) : 0;
  return {
    mode: mode === 'shadow' || mode === 'on' ? mode : 'off',
    percent: percent >= 0 && percent <= 100 ? percent : 0,
  };
}
