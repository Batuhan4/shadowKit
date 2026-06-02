import type { ProposalView } from "@shadowkit/shared";

export interface VoteModalProps {
  proposal: ProposalView;
  voter: string;            // voter address (M1 plaintext; M4 replaces with ZK props)
  onCast: (direction: 0 | 1) => void;
}

export function VoteModal({ proposal, voter, onCast }: VoteModalProps) {
  return (
    <div className="vote-modal" role="dialog" aria-label={`Vote on proposal ${proposal.id}`}>
      <h2>Vote on Proposal #{proposal.id}</h2>
      <p className="vote-action">
        Swap {proposal.actionSpec.amount} {proposal.actionSpec.assetIn} →{" "}
        {proposal.actionSpec.assetOut}
      </p>
      <p className="vote-voter">Voting as {voter}</p>
      {/* PRIVACY INVARIANT (foundation §7): the modal renders NO tally. It must never read
          proposal.weightedYes / proposal.weightedNo. Results are hidden until close. */}
      <div className="vote-actions">
        <button type="button" onClick={() => onCast(1)}>Vote Yes</button>
        <button type="button" onClick={() => onCast(0)}>Vote No</button>
      </div>
    </div>
  );
}
