import { ethers } from 'ethers';
import { useEffect, useState } from 'react';
import {
  DEX_ADDRESSES, ETH, balanceOf, dexContract, ensureAllowance, fmt, formatTime, loadPools, pairName, parse,
  symOf, useWeb3, type FullPool,
} from '../lib/web3';

interface MyPosition {
  dex: string;
  dexName: string;
  tokenId: bigint;
  pool: FullPool;
  liquidity: bigint;
  amountA: bigint;
  amountB: bigint;
  valueA: bigint;
  valueB: bigint;
  createdTimestamp: bigint;
}

function AddLiquidity({ pools }: { pools: FullPool[] }) {
  const w = useWeb3();
  const [poolKey, setPoolKey] = useState('');
  const [amountA, setAmountA] = useState('10');
  const [amountB, setAmountB] = useState('');
  const [bal, setBal] = useState<[bigint, bigint]>();
  const [busy, setBusy] = useState(false);
  const keyOf = (p: FullPool) => `${p.dex}-${p.poolId}`;
  const pool = pools.find((p) => keyOf(p) === poolKey) ?? pools[0];

  // 按当前储备比例自动计算另一侧数量
  const onChangeA = (v: string) => {
    setAmountA(v);
    if (pool) setAmountB(ethers.formatEther((parse(v) * pool.reserveB) / pool.reserveA));
  };
  const onChangeB = (v: string) => {
    setAmountB(v);
    if (pool) setAmountA(ethers.formatEther((parse(v) * pool.reserveA) / pool.reserveB));
  };
  useEffect(() => { onChangeA(amountA); }, [poolKey, pools.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    Promise.all([balanceOf(w.provider, pool.tokenA, w.address), balanceOf(w.provider, pool.tokenB, w.address)])
      .then(([a, b]) => { if (!cancelled) setBal([a, b]); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [pool?.dex, pool?.poolId, w.provider, w.address, w.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pool) return null;
  const a = parse(amountA);
  const b = parse(amountB);
  const expectedLiquidity = pool.totalLiquidity > 0n && pool.reserveA > 0n
    ? [a * pool.totalLiquidity / pool.reserveA, b * pool.totalLiquidity / pool.reserveB].reduce((x, y) => (x < y ? x : y))
    : 0n;
  const share = pool.totalLiquidity > 0n
    ? Number((expectedLiquidity * 1000000n) / (pool.totalLiquidity + expectedLiquidity)) / 10000
    : 0;

  const submit = async () => {
    if (a === 0n || b === 0n) return;
    setBusy(true);
    try {
      await ensureAllowance(w, pool.tokenA, pool.dex, a);
      await ensureAllowance(w, pool.tokenB, pool.dex, b);
      const value = pool.tokenA === ETH ? a : pool.tokenB === ETH ? b : 0n;
      await w.sendTx(`添加流动性 ${pairName(w.symbols, pool)}（${pool.dexName}）`, () =>
        dexContract(pool.dex, w.signer).addLiquidity(pool.poolId, a, b, { value }),
      );
    } catch {
      /* 错误已显示在交易日志中 */
    } finally {
      setBusy(false);
    }
  };

  const sA = symOf(w.symbols, pool.tokenA);
  const sB = symOf(w.symbols, pool.tokenB);
  return (
    <section className="card">
      <h2>添加流动性</h2>
      <p className="muted">按池子当前比例注入两种代币，获得一个 ERC721 NFT 作为流动性凭证。</p>
      <div className="form">
        <label>交易池
          <select value={keyOf(pool)} onChange={(e) => setPoolKey(e.target.value)}>
            {pools.map((p) => (
              <option key={keyOf(p)} value={keyOf(p)}>{p.dexName} #{p.poolId} {pairName(w.symbols, p)}</option>
            ))}
          </select>
        </label>
        <label>{sA} 数量 <input value={amountA} onChange={(e) => onChangeA(e.target.value)} /></label>
        <label>{sB} 数量 <input value={amountB} onChange={(e) => onChangeB(e.target.value)} /></label>
        <button disabled={busy} onClick={submit}>添加流动性</button>
      </div>
      <p className="muted">
        余额：{fmt(bal?.[0])} {sA} · {fmt(bal?.[1])} {sB} ｜ 预计获得份额 {fmt(expectedLiquidity)}（占池子 {share.toFixed(2)}%）
      </p>
    </section>
  );
}

function MyPositions({ pools }: { pools: FullPool[] }) {
  const w = useWeb3();
  const [positions, setPositions] = useState<MyPosition[]>([]);
  const [metadata, setMetadata] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result: MyPosition[] = [];
      for (const dexAddr of DEX_ADDRESSES) {
        const dex = dexContract(dexAddr, w.provider);
        const [ids, infos] = await dex.getPositionsOf(w.address);
        for (let i = 0; i < ids.length; i++) {
          const pool = pools.find((p) => p.dex === dexAddr && p.poolId === Number(infos[i].poolId));
          if (!pool) continue;
          const [valueA, valueB] = await dex.positionValue(ids[i]);
          result.push({
            dex: dexAddr, dexName: pool.dexName, tokenId: ids[i], pool,
            liquidity: infos[i].liquidity, amountA: infos[i].amountA, amountB: infos[i].amountB,
            valueA, valueB, createdTimestamp: infos[i].createdTimestamp,
          });
        }
      }
      if (!cancelled) setPositions(result);
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [pools, w.provider, w.address]);

  const showMetadata = async (p: MyPosition) => {
    const uri: string = await dexContract(p.dex, w.provider).tokenURI(p.tokenId);
    const json = JSON.parse(atob(uri.split(',')[1]));
    setMetadata(JSON.stringify(json, null, 2));
  };

  const remove = (p: MyPosition) =>
    w.sendTx(`销毁 ${p.dexName} NFT #${p.tokenId} 取回流动性`, () =>
      dexContract(p.dex, w.signer).removeLiquidity(p.tokenId),
    ).catch(() => {});

  return (
    <section className="card">
      <h2>我的流动性 NFT</h2>
      {positions.length === 0 ? (
        <p className="muted">当前账户没有 LP NFT。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>NFT</th><th>交易所 / 池子</th><th>流动性份额</th><th>占比</th><th>存入</th>
              <th>当前可取回（含手续费分红）</th><th>时间</th><th></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const sA = symOf(w.symbols, p.pool.tokenA);
              const sB = symOf(w.symbols, p.pool.tokenB);
              const share = Number((p.liquidity * 1000000n) / p.pool.totalLiquidity) / 10000;
              // 用当前价格把 B 折算成 A 来估算总价值变化（价格变化会带来无常损失，手续费会带来收益）
              const toA = (x: bigint, y: bigint) => x + (y * p.pool.reserveA) / p.pool.reserveB;
              const rawGain = toA(p.valueA, p.valueB) - toA(p.amountA, p.amountB);
              // 整数除法会产生极小的舍入误差（如 -2e-18），视为 0
              const gain = rawGain > -(10n ** 12n) && rawGain < 10n ** 12n ? 0n : rawGain;
              return (
                <tr key={`${p.dex}-${p.tokenId}`}>
                  <td>#{p.tokenId.toString()}</td>
                  <td>{p.dexName} #{p.pool.poolId} {sA}/{sB}</td>
                  <td>{fmt(p.liquidity)}</td>
                  <td>{share.toFixed(2)}%</td>
                  <td>{fmt(p.amountA)} {sA}<br />{fmt(p.amountB)} {sB}</td>
                  <td>
                    {fmt(p.valueA)} {sA}<br />{fmt(p.valueB)} {sB}<br />
                    <span className={gain >= 0n ? 'pos' : 'neg'}>
                      折合 {gain >= 0n ? '+' : ''}{fmt(gain, 6)} {sA}
                    </span>
                  </td>
                  <td>{formatTime(p.createdTimestamp)}</td>
                  <td>
                    <button onClick={() => showMetadata(p)}>元数据</button>
                    <button onClick={() => remove(p)}>销毁并取回</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {metadata && (
        <>
          <h3>NFT 元数据（tokenURI 链上生成）</h3>
          <pre>{metadata}</pre>
        </>
      )}
    </section>
  );
}

export default function LiquidityPanel() {
  const w = useWeb3();
  const [pools, setPools] = useState<FullPool[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadPools(w.provider).then((p) => {
      if (cancelled) return;
      setPools(p);
      w.ensureSymbols(p.flatMap((x) => [x.tokenA, x.tokenB]));
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pools.length === 0) return <p className="muted">暂无交易池。</p>;
  return (
    <>
      <AddLiquidity pools={pools} />
      <MyPositions pools={pools} />
    </>
  );
}
