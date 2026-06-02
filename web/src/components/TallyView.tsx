import type { ProposalView } from "@shadowkit/shared";

export interface TallyViewProps {
  proposal: ProposalView;
}

/** M1 plaintext tally view. Shows results ONLY once the proposal has been closed
 *  (weightedYes/weightedNo non-null). Before close it shows "results hidden". The M5
 *  sealed-reveal equivalent is foundation §3.7 RevealedResult. */
export function TallyView({ proposal }: TallyViewProps) {
  const revealed = proposal.weightedYes !== null && proposal.weightedNo !== null;
  if (!revealed) {
    return <div className="tally-view tally-hidden">Results hidden until close</div>;
  }
  return (
    <div className="tally-view tally-revealed">
      <p className="tally-yes">Yes: {proposal.weightedYes}</p>
      <p className="tally-no">No: {proposal.weightedNo}</p>
      <p className="tally-outcome">{proposal.status}</p>
    </div>
  );
}
