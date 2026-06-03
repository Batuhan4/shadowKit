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
      <span className="badge badge-green" title={address}>
        <span className="wc-dot" /> {short(address, 4, 4)}
      </span>
      <button type="button" className="btn btn-ghost wc-disc" onClick={onDisconnect}>
        Disconnect
      </button>
      <style>{`
        .wc-connected { display: inline-flex; align-items: center; gap: .6rem; }
        .wc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); display: inline-block; }
        .wc-disc { padding: .45em .9em; font-size: .85rem; }
      `}</style>
    </div>
  );
}
