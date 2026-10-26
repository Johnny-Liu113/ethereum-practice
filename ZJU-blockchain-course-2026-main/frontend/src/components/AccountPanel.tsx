import { useEffect, useState } from 'react';
import {
  ADDRESSES, ETH, KNOWN_TOKENS, balanceOf, faucetContract, fmt, symOf, tokenContract, useWeb3,
} from '../lib/web3';

export default function AccountPanel() {
  const w = useWeb3();
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [faucetBalance, setFaucetBalance] = useState<bigint>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        KNOWN_TOKENS.map(async (t) => [t, await balanceOf(w.provider, t, w.address)] as const),
      );
      const fb = await w.provider.getBalance(ADDRESSES.ethFaucet);
      if (!cancelled) {
        setBalances(Object.fromEntries(entries));
        setFaucetBalance(fb);
      }
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.address, w.version]);

  const claimToken = (t: string) =>
    w.sendTx(`领取 1000 ${symOf(w.symbols, t)}`, () => tokenContract(t, w.signer).faucet()).catch(() => {});
  const claimEth = () =>
    w.sendTx('领取 1 ETH', () => faucetContract(w.signer).claim()).catch(() => {});

  const watchAsset = async (t: string) => {
    try {
      await (window.ethereum as any)?.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: t, symbol: symOf(w.symbols, t), decimals: 18 } },
      });
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <section className="card">
      <h2>我的资产</h2>
      <p className="muted">地址：<code>{w.address}</code></p>
      <table>
        <thead>
          <tr><th>资产</th><th>余额</th><th>合约地址</th><th>操作</th></tr>
        </thead>
        <tbody>
          {KNOWN_TOKENS.map((t) => (
            <tr key={t}>
              <td>{symOf(w.symbols, t)}</td>
              <td>{fmt(balances[t])}</td>
              <td><code>{t === ETH ? '原生代币' : t}</code></td>
              <td>
                {t === ETH ? (
                  <button onClick={claimEth}>领取 1 ETH</button>
                ) : (
                  <>
                    <button onClick={() => claimToken(t)}>领取 1000</button>
                    {window.ethereum && <button onClick={() => watchAsset(t)}>添加到 MetaMask</button>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">ETH 水龙头剩余：{fmt(faucetBalance)} ETH。代币水龙头不限次数，每次铸造 1000 个。</p>
      <p className="muted">
        提示：在“本地节点账户”模式下，可以在右上角切换不同用户，模拟多个用户分别领取代币、交易和提供流动性。
      </p>
    </section>
  );
}
