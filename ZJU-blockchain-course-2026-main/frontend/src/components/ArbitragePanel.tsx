import { useEffect, useMemo, useState } from 'react';
import {
  ADDRESSES, ETH, KNOWN_TOKENS, arbitrageContract, balanceOf, dexContract, ensureAllowance, errorMessage, fmt,
  loadPools, pairName, symOf, useWeb3, type FullPool,
} from '../lib/web3';
import { findOpportunities, priceOf, same, type Opportunity } from '../lib/arbFinder';

interface PoolSnapshot {
  label: string;
  price: number;
  reserveA: bigint;
  reserveB: bigint;
}

interface ArbResult {
  ok: boolean;
  description: string;
  token: string;
  amountIn: bigint;
  expectedProfit: bigint;
  minProfit: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  gasCost: bigint;
  before: PoolSnapshot[];
  after: PoolSnapshot[];
  error?: string;
}

export default function ArbitragePanel() {
  const w = useWeb3();
  const [pools, setPools] = useState<FullPool[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [result, setResult] = useState<ArbResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await loadPools(w.provider);
      const entries = await Promise.all(
        KNOWN_TOKENS.map(async (t) => [t.toLowerCase(), await balanceOf(w.provider, t, w.address)] as const),
      );
      if (cancelled) return;
      setPools(p);
      setBalances(Object.fromEntries(entries));
      setLoaded(true);
      w.ensureSymbols(p.flatMap((x) => [x.tokenA, x.tokenB]));
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.address, w.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // 投入上限 = 当前账户余额（ETH 保留一半作为 gas）
  const opportunities = useMemo(
    () => findOpportunities(pools, (t) => {
      const b = balances[t.toLowerCase()];
      if (b === undefined) return 0n;
      return t === ETH ? b / 2n : b;
    }).slice(0, 12),
    [pools, balances],
  );

  // 同一代币对在不同交易所的价格对比
  const priceTable = useMemo(() => {
    const groups = new Map<string, FullPool[]>();
    for (const p of pools) {
      const key = [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()].sort().join('-');
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }, [pools]);

  const describe = (op: Opportunity) =>
    [symOf(w.symbols, op.startToken), ...op.steps.map((s) => {
      const out = same(s.pool.tokenA, s.tokenIn) ? s.pool.tokenB : s.pool.tokenA;
      return `[${s.pool.dexName} #${s.pool.poolId}] ${symOf(w.symbols, out)}`;
    })].join(' → ');

  const snapshot = async (op: Opportunity): Promise<PoolSnapshot[]> =>
    Promise.all(op.steps.map(async (s) => {
      const p = await dexContract(s.pool.dex, w.provider).getPool(s.pool.poolId);
      const info = { ...s.pool, reserveA: p.reserveA, reserveB: p.reserveB };
      return {
        label: `${s.pool.dexName} #${s.pool.poolId} ${pairName(w.symbols, s.pool)}`,
        price: priceOf(info),
        reserveA: p.reserveA,
        reserveB: p.reserveB,
      };
    }));

  /** forceFail=true 时把最低利润设为预期利润的 10 倍，用来演示失败时整笔交易回滚 */
  const execute = async (op: Opportunity, forceFail = false) => {
    setBusy(true);
    const minProfit = forceFail ? op.profit * 10n : op.profit / 2n;
    const before = await snapshot(op);
    const balanceBefore = await balanceOf(w.provider, op.startToken, w.address);
    let ok = false;
    let error: string | undefined;
    let gasCost = 0n;
    try {
      await ensureAllowance(w, op.startToken, ADDRESSES.arbitrage, op.amountIn);
      const steps = op.steps.map((s) => ({ dex: s.pool.dex, poolId: s.pool.poolId, tokenIn: s.tokenIn }));
      const receipt = await w.sendTx(forceFail ? '套利（失败测试）' : '执行原子套利', () =>
        arbitrageContract(w.signer).executeArbitrage(steps, op.amountIn, minProfit, {
          value: op.startToken === ETH ? op.amountIn : 0n,
          // 失败测试时跳过 estimateGas（否则在预估阶段就会报错，不会真正上链）
          ...(forceFail ? { gasLimit: 1_000_000n } : {}),
        }),
      );
      ok = true;
      if (receipt) gasCost = receipt.gasUsed * receipt.gasPrice;
    } catch (err) {
      error = errorMessage(err);
    }
    const after = await snapshot(op);
    const balanceAfter = await balanceOf(w.provider, op.startToken, w.address);
    setResult({
      ok, description: describe(op), token: op.startToken, amountIn: op.amountIn,
      expectedProfit: op.profit, minProfit, balanceBefore, balanceAfter, gasCost, before, after, error,
    });
    setBusy(false);
  };

  // 在某个池子做一笔大额交易，人为制造价差，便于演示
  const createGap = async () => {
    const pool = pools[0];
    if (!pool) return;
    const amount = pool.reserveB / 10n;
    setBusy(true);
    try {
      await ensureAllowance(w, pool.tokenB, pool.dex, amount);
      await w.sendTx(`在 ${pool.dexName} #${pool.poolId} 大额卖出 ${symOf(w.symbols, pool.tokenB)}（制造价差）`, () =>
        dexContract(pool.dex, w.signer).swap(pool.poolId, pool.tokenB, amount, 0),
      );
    } catch {
      /* 错误已显示在交易日志中 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>不同交易所的价格对比</h2>
        <table>
          <thead><tr><th>交易对</th><th>各交易所价格（1 A = ? B）</th><th>最大价差</th></tr></thead>
          <tbody>
            {priceTable.map((g) => {
              const base = g[0];
              // 统一换算成 base.tokenA 计价
              const prices = g.map((p) => same(p.tokenA, base.tokenA) ? priceOf(p) : 1 / priceOf(p));
              const gap = (Math.max(...prices) / Math.min(...prices) - 1) * 100;
              return (
                <tr key={`${base.dex}-${base.poolId}`}>
                  <td>{pairName(w.symbols, base)}</td>
                  <td>{g.map((p, i) => <div key={i}>{p.dexName} #{p.poolId}：{prices[i].toPrecision(6)}</div>)}</td>
                  <td className={gap > 0.6 ? 'pos' : ''}>{gap.toFixed(3)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button disabled={busy} onClick={createGap}>制造价差（在第一个池子大额交易）</button>
      </section>

      <section className="card">
        <h2>套利机会</h2>
        <p className="muted">
          枚举跨交易所的两步环路（低价买入、高价卖出）和三池三角环路，用三分搜索求出使利润最大的投入量
          （受当前账户余额限制）。执行时整条路径在 Arbitrage 合约的一笔交易中完成，利润不足则整体 revert。
        </p>
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : opportunities.length === 0 ? (
          <p className="muted">暂无有利可图的套利机会（可以先去交易或点击“制造价差”）。</p>
        ) : (
          <table>
            <thead>
              <tr><th>路径</th><th>投入</th><th>预计产出</th><th>预计利润</th><th>利润率</th><th></th></tr>
            </thead>
            <tbody>
              {opportunities.map((op, i) => {
                const s = symOf(w.symbols, op.startToken);
                return (
                  <tr key={i}>
                    <td>{describe(op)}</td>
                    <td>{fmt(op.amountIn)} {s}</td>
                    <td>{fmt(op.amountOut)} {s}</td>
                    <td className="pos">+{fmt(op.profit, 6)} {s}</td>
                    <td>{(op.profitBps / 100).toFixed(2)}%</td>
                    <td>
                      <button disabled={busy} onClick={() => execute(op)}>执行套利</button>
                      <button disabled={busy} onClick={() => execute(op, true)}>失败测试</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {result && <ResultCard r={result} />}
    </>
  );
}

function ResultCard({ r }: { r: ArbResult }) {
  const w = useWeb3();
  const s = symOf(w.symbols, r.token);
  // ETH 套利时余额变化包含 gas，这里单独展示
  const delta = r.balanceAfter - r.balanceBefore;
  const profitExGas = r.token === ETH ? delta + r.gasCost : delta;
  return (
    <section className={`card ${r.ok ? 'ok' : 'fail'}`}>
      <h2>{r.ok ? '✔ 套利成功' : '✘ 套利失败，交易已回滚'}</h2>
      <p>{r.description}</p>
      {r.error && <p className="neg">原因：{r.error}</p>}
      <table className="kv">
        <tbody>
          <tr><td>投入</td><td>{fmt(r.amountIn, 6)} {s}</td></tr>
          <tr><td>预计利润 / 最低利润要求</td><td>{fmt(r.expectedProfit, 6)} / {fmt(r.minProfit, 6)} {s}</td></tr>
          <tr><td>{s} 余额</td><td>{fmt(r.balanceBefore, 6)} → {fmt(r.balanceAfter, 6)}</td></tr>
          <tr>
            <td>实际利润{r.token === ETH ? '（不含 gas）' : ''}</td>
            <td className={profitExGas > 0n ? 'pos' : ''}>{profitExGas >= 0n ? '+' : ''}{fmt(profitExGas, 6)} {s}</td>
          </tr>
        </tbody>
      </table>
      <table>
        <thead><tr><th>池子</th><th>套利前价格</th><th>套利后价格</th><th>套利前储备</th><th>套利后储备</th></tr></thead>
        <tbody>
          {r.before.map((b, i) => (
            <tr key={i}>
              <td>{b.label}</td>
              <td>{b.price.toPrecision(6)}</td>
              <td>{r.after[i].price.toPrecision(6)}</td>
              <td>{fmt(b.reserveA)} / {fmt(b.reserveB)}</td>
              <td>{fmt(r.after[i].reserveA)} / {fmt(r.after[i].reserveB)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
