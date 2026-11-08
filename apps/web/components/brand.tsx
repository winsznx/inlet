export function InletSymbol({ size = 28, reversed = false, className }: { size?: number; reversed?: boolean; className?: string }) {
  const line = reversed ? "#FFFFFF" : "#15191B";
  const terminal = reversed ? "#D59870" : "#A5643C";
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden className={className}>
      <path d="M9 18H31C40 18 45 23 45 32V40" fill="none" stroke={line} strokeWidth="7" strokeLinejoin="round" strokeLinecap="square" />
      <path d="M9 32H22C29 32 33 36 33 43V46" fill="none" stroke={line} strokeWidth="7" strokeLinejoin="round" strokeLinecap="square" />
      <rect x="28" y="44" width="17" height="17" rx="1" fill={terminal} />
    </svg>
  );
}

export function InletLockup({ reversed = false, size = 26 }: { reversed?: boolean; size?: number }) {
  return (
    <span className={`inline-flex items-center gap-2 ${reversed ? "text-white" : "text-ink"}`}>
      <InletSymbol size={size} reversed={reversed} />
      <span className="font-display text-[21px] font-semibold leading-none tracking-[-0.03em]">Inlet</span>
    </span>
  );
}
