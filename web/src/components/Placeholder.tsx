// web/src/components/Placeholder.tsx — M0 placeholder island (replaced by real islands in M1+).
export interface PlaceholderProps {
  title: string;
}

export default function Placeholder({ title }: PlaceholderProps) {
  return (
    <main data-testid="agentboard-placeholder">
      <h1>{title}</h1>
      <p>ShadowKit AgentBoard — scaffold online. Voting & agent UI arrive in M1+.</p>
    </main>
  );
}
