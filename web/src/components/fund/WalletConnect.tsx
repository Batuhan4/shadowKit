// WalletConnect — presentational connect/disconnect control. The actual Stellar Wallets Kit wiring
// (init/authModal/getAddress/signTransaction) lives in the page island (fund.astro) so this component
// stays trivially testable: it just renders the connect/connected states and emits callbacks.
import { short } from "../../lib/config";

export interface WalletConnectProps {
  address: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  busy?: boolean;
}

export function WalletConnect({ address, onConnect, onDisconnect, busy }: WalletConnectProps) {
  if (!address) {
    return (
      <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
        {busy ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  return (
    <div className="wc-connected">
      <span className="tag tag-lime wc-addr" title={address}>
        <span className="wc-dot" /> {short(address, 4, 4)}
      </span>
      <button type="button" className="btn btn-ghost wc-disc" onClick={onDisconnect}>
        Disconnect
      </button>
      <style>{`
        .wc-connected { display: inline-flex; align-items: center; gap: .55rem; }
        .wc-addr { font-size: .72rem; }
        .wc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); display: inline-block; }
        .wc-disc { padding: .5em .9em; font-size: .8rem; }
      `}</style>
    </div>
  );
}
