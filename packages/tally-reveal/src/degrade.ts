// packages/tally-reveal/src/degrade.ts
// FALLBACK ladder (spec §13.2): weight-unlinked and 1p1v aggregation modes.
type Decrypted = { direction: 0 | 1; weight: string };

/** Weight-unlinked: ignore weight, count each included vote as 1 (preserves weight privacy). */
export function aggregateUnlinked(decrypted: Decrypted[]): { yesW: string; noW: string } {
  let yes = 0n, no = 0n;
  for (const d of decrypted) { if (d.direction === 1) yes += 1n; else no += 1n; }
  return { yesW: yes.toString(), noW: no.toString() };
}

/** 1-person-1-vote: identical head-count semantics (named per spec for the final rung). */
export function aggregate1p1v(decrypted: Decrypted[]): { yesW: string; noW: string } {
  return aggregateUnlinked(decrypted);
}
