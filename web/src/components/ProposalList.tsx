import type { ProposalView } from "@shadowkit/shared";

export interface ProposalListProps {
  proposals: ProposalView[];
  onSelect: (id: number) => void;
}

export function ProposalList({ proposals, onSelect }: ProposalListProps) {
  return (
    <ul className="proposal-list">
      {proposals.map((p) => (
        <li
          key={p.id}
          className="proposal-row"
          role="button"
          tabIndex={0}
          onClick={() => onSelect(p.id)}
        >
          <span className="proposal-title">Proposal #{p.id}</span>
          <span className="proposal-status">{p.status}</span>
          <span className="proposal-votes">{p.votesCast} votes</span>
        </li>
      ))}
    </ul>
  );
}
