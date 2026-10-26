import { useEffect, useMemo, useState } from 'react';
import {
  ETH, balanceOf, dexContract, ensureAllowance, fmt, loadPools, pairName, parse, symOf, useWeb3,
  type FullPool,
} from '../lib/web3';
import { getAmountOut, otherToken, same } from '../lib/arbFinder';

export default function SwapPanel() {
  const w = useWeb3();
  const [pools, setPools] = useState<FullPool[]>([]);
  const [poolKey, setPoolKey] = useState('');
  const [tokenIn, setTokenIn] = useState('');
  const [amount, setAmount] = useState('10');
  const [slippage, setSlippage] = useState('1');
  const [balIn, setBalIn] = useState<bigint>();
  const [balOut, setBalOut] = useState<bigint>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPools(w.provider).then((p) => {
      if (cancelled) return;
      setPools(p);
      w.ensureSymbols(p.flatMap((x) => [x.tokenA, x.tokenB]));
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const keyOf = (p: FullPool) => `${p.dex}-${p.poolId}`;
  const pool = pools.find((p) => keyOf(p) === poolKey) ?? pools[0];
  const inToken = pool && (same(tokenIn, pool.tokenA) || same(tokenIn, pool.tokenB)) ? tokenIn : pool?.tokenA;
  const outToken = pool && inToken ? otherToken(pool, inToken) : '';

  useEffect(() => {
    if (!inToken || !outToken) return;
    let cancelled = false;
    Promise.all([balanceOf(w.provider, inToken, w.address), balanceOf(w.provider, outToken, w.address)])
      .then(([a, b]) => { if (!cancelled) { setBalIn(a); setBalOut(b); } })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [inToken, outToken, w.provider, w.address, w.version]);

  const amountIn = parse(amount);
  const quote = useMemo(() => {
    if (!pool || !inToken || amountIn === 0n) return null;
    const out = getAmountOut(pool, inToken, amountIn);
    const reserveIn = same(pool.tokenA, inToken) ? pool.reserveA : pool.reserveB;
    const reserveOut = same(pool.tokenA, inToken) ? pool.reserveB : pool.reserveA;
    const spot = Number(reserveOut) / Number(reserveIn);              // 交易前的边际价格
    const exec = Number(out) / Number(amountIn);                        // 实际成交均价
    const fee = (amountIn * pool.feeBps) / 10000n;
    return { out, spot, exec, impact: (1 - exec / spot) * 100, fee };
  }, [pool, inToken, amountIn]);

  // 同一代币对在其他交易所的报价，便于观察价差
  const otherQuotes = useMemo(() => {
    if (!pool || !inToken || amountIn === 0n) return [];
    return pools
      .filter((p) => p !== pool && (same(p.tokenA, inToken) || same(p.tokenB, inToken)) &&
        (same(p.tokenA, outToken) || same(p.tokenB, outToken)))
      .map((p) => ({ pool: p, out: getAmountOut(p, inToken, amountIn) }));
  }, [pools, pool, inToken, outToken, amountIn]);

  const submit = async () => {
    if (!pool || !quote) return;
    setBusy(true);
    try {
      const slipBps = BigInt(Math.round(Number(slippage) * 100));
      const minOut = (quote.out * (10000n - slipBps)) / 10000n;
      await ensureAllowance(w, inToken, pool.dex, amountIn);
      await w.sendTx(
        `兑换 ${amount} ${symOf(w.symbols, inToken)} → ${symOf(w.symbols, outToken)}（${pool.dexName}）`,
        () => dexContract(pool.dex, w.signer).swap(pool.poolId, inToken, amountIn, minOut, {
          value: inToken === ETH ? amountIn : 0n,
        }),
      );
    } catch {
      /* 错误已显示在交易日志中 */
    } finally {
      setBusy(false);
    }
  };

  if (!pool) return <p className="muted">暂无交易池。</p>;
  const sIn = symOf(w.symbols, inToken);
  const sOut = symOf(w.symbols, outToken);

  return (
    <section className="card">
      <h2>代币兑换</h2>
      <div className="form">
        <label>交易池
          <select value={keyOf(pool)} onChange={(e) => setPoolKey(e.target.value)}>
            {pools.map((p) => (
              <option key={keyOf(p)} value={keyOf(p)}>{p.dexName} #{p.poolId} {pairName(w.symbols, p)}</option>
            ))}
          </select>
        </label>
        <label>卖出
          <select value={inToken} onChange={(e) => setTokenIn(e.target.value)}>
            <option value={pool.tokenA}>{symOf(w.symbols, pool.tokenA)}</option>
            <option value={pool.tokenB}>{symOf(w.symbols, pool.tokenB)}</option>
          </select>
        </label>
        <label>数量 <input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>滑点容忍 (%) <input value={slippage} onChange={(e) => setSlippage(e.target.value)} /></label>
      </div>
      <p className="muted">余额：{fmt(balIn)} {sIn} · {fmt(balOut)} {sOut}</p>

      {quote && (
        <table className="kv">
          <tbody>
            <tr><td>预计获得</td><td><b>{fmt(quote.out, 6)} {sOut}</b></td></tr>
            <tr><td>当前价格</td><td>1 {sIn} = {quote.spot.toPrecision(6)} {sOut}</td></tr>
            <tr><td>成交均价</td><td>1 {sIn} = {quote.exec.toPrecision(6)} {sOut}</td></tr>
            <tr><td>价格影响（含手续费）</td><td className={quote.impact > 5 ? 'neg' : ''}>{quote.impact.toFixed(3)}%</td></tr>
            <tr><td>手续费（{Number(pool.feeBps) / 100}%，归 LP）</td><td>{fmt(quote.fee, 6)} {sIn}</td></tr>
            <tr><td>公式</td><td><code>out = in·(1−fee)·R_out / (R_in + in·(1−fee))</code></td></tr>
            {otherQuotes.map((q) => (
              <tr key={`${q.pool.dex}-${q.pool.poolId}`}>
                <td>对比：{q.pool.dexName} #{q.pool.poolId}</td>
                <td className={q.out > quote.out ? 'pos' : 'neg'}>{fmt(q.out, 6)} {sOut}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button disabled={busy || !quote || quote.out === 0n} onClick={submit}>兑换</button>
    </section>
  );
}
