import { ethers } from 'ethers';
import { useEffect, useState } from 'react';
import {
  ETH, KNOWN_TOKENS, dexContract, ensureAllowance, fmt, formatTime, loadDexes, loadPools, pairName, parse,
  shortAddr, symOf, useWeb3, type DexMeta, type FullPool,
} from '../lib/web3';
import { priceOf } from '../lib/arbFinder';

interface PositionRow {
  tokenId: bigint;
  owner: string;
  provider: string;
  liquidity: bigint;
  amountA: bigint;
  amountB: bigint;
  createdTimestamp: bigint;
}

function PoolSources({ pool }: { pool: FullPool }) {
  const w = useWeb3();
  const [rows, setRows] = useState<PositionRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    dexContract(pool.dex, w.provider).getPoolPositions(pool.poolId).then(([ids, infos, owners]: any) => {
      if (cancelled) return;
      setRows(ids.map((id: bigint, i: number) => ({
        tokenId: id,
        owner: owners[i],
        provider: infos[i].provider,
        liquidity: infos[i].liquidity,
        amountA: infos[i].amountA,
        amountB: infos[i].amountB,
        createdTimestamp: infos[i].createdTimestamp,
      })));
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [pool.dex, pool.poolId, w.provider, w.version]);

  const a = symOf(w.symbols, pool.tokenA);
  const b = symOf(w.symbols, pool.tokenB);
  return (
    <tr className="sub">
      <td colSpan={9}>
        <b>流动性来源</b>（锁定的最小流动性 1000 wei 不计入）
        <table>
          <thead>
            <tr>
              <th>NFT</th><th>当前持有人</th><th>提供者</th><th>流动性份额</th><th>占比</th>
              <th>存入 {a}</th><th>存入 {b}</th><th>当前可取回</th><th>时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tokenId.toString()} className={r.owner === w.address ? 'mine' : ''}>
                <td>#{r.tokenId.toString()}</td>
                <td title={r.owner}>{shortAddr(r.owner)}{r.owner === w.address && '（我）'}</td>
                <td title={r.provider}>{shortAddr(r.provider)}</td>
                <td>{fmt(r.liquidity)}</td>
                <td>{(Number((r.liquidity * 1000000n) / pool.totalLiquidity) / 10000).toFixed(2)}%</td>
                <td>{fmt(r.amountA)}</td>
                <td>{fmt(r.amountB)}</td>
                <td>
                  {fmt((r.liquidity * pool.reserveA) / pool.totalLiquidity)} {a} +{' '}
                  {fmt((r.liquidity * pool.reserveB) / pool.totalLiquidity)} {b}
                </td>
                <td>{formatTime(r.createdTimestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

function CreatePool({ dexes }: { dexes: DexMeta[] }) {
  const w = useWeb3();
  const [dex, setDex] = useState(dexes[0]?.address ?? '');
  const [tokenA, setTokenA] = useState(KNOWN_TOKENS[1]);
  const [tokenB, setTokenB] = useState(KNOWN_TOKENS[3]);
  const [customA, setCustomA] = useState('');
  const [customB, setCustomB] = useState('');
  const [amountA, setAmountA] = useState('100');
  const [amountB, setAmountB] = useState('100');
  const [busy, setBusy] = useState(false);

  const realA = customA.trim() || tokenA;
  const realB = customB.trim() || tokenB;
  useEffect(() => {
    const extra = [customA, customB].filter((t) => ethers.isAddress(t.trim()));
    if (extra.length) w.ensureSymbols(extra.map((t) => t.trim()));
  }, [customA, customB, w]);

  const submit = async () => {
    if (!ethers.isAddress(realA) || !ethers.isAddress(realB)) return alert('代币地址无效');
    const a = parse(amountA);
    const b = parse(amountB);
    if (a === 0n || b === 0n) return alert('请输入数量');
    setBusy(true);
    try {
      const [exists] = await dexContract(dex, w.provider).findPool(realA, realB);
      if (exists) throw new Error('该交易所已存在此代币对的池子');
      await ensureAllowance(w, realA, dex, a);
      await ensureAllowance(w, realB, dex, b);
      const value = realA === ETH ? a : realB === ETH ? b : 0n;
      await w.sendTx(`创建池子 ${symOf(w.symbols, realA)}/${symOf(w.symbols, realB)}`, () =>
        dexContract(dex, w.signer).createPool(realA, realB, a, b, { value }),
      );
    } catch (err: any) {
      if (!err?.code) alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  const tokenSelect = (v: string, set: (s: string) => void) => (
    <select value={v} onChange={(e) => set(e.target.value)}>
      {KNOWN_TOKENS.map((t) => <option key={t} value={t}>{symOf(w.symbols, t)}</option>)}
    </select>
  );

  return (
    <section className="card">
      <h2>创建交易池</h2>
      <p className="muted">初始注入的两种代币数量之比即为初始价格。可以选择已有代币，也可以填写任意自己持有的 ERC20 合约地址。</p>
      <div className="form">
        <label>交易所
          <select value={dex} onChange={(e) => setDex(e.target.value)}>
            {dexes.map((d) => <option key={d.address} value={d.address}>{d.name}</option>)}
          </select>
        </label>
        <label>代币 A {tokenSelect(tokenA, setTokenA)}
          <input placeholder="或输入 ERC20 地址" value={customA} onChange={(e) => setCustomA(e.target.value)} />
        </label>
        <label>数量 A <input value={amountA} onChange={(e) => setAmountA(e.target.value)} /></label>
        <label>代币 B {tokenSelect(tokenB, setTokenB)}
          <input placeholder="或输入 ERC20 地址" value={customB} onChange={(e) => setCustomB(e.target.value)} />
        </label>
        <label>数量 B <input value={amountB} onChange={(e) => setAmountB(e.target.value)} /></label>
        <button disabled={busy} onClick={submit}>创建并注入流动性</button>
      </div>
    </section>
  );
}

export default function PoolsPanel() {
  const w = useWeb3();
  const [dexes, setDexes] = useState<DexMeta[]>([]);
  const [pools, setPools] = useState<FullPool[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await loadDexes(w.provider);
      const p = await loadPools(w.provider, d);
      if (cancelled) return;
      setDexes(d);
      setPools(p);
      w.ensureSymbols(p.flatMap((x) => [x.tokenA, x.tokenB]));
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {dexes.map((d) => (
        <section className="card" key={d.address}>
          <h2>{d.name} <span className="muted">手续费 {Number(d.feeBps) / 100}% · {shortAddr(d.address)}</span></h2>
          <table>
            <thead>
              <tr>
                <th>ID</th><th>交易对</th><th>储备 A</th><th>储备 B</th><th>价格 (1 A = ? B)</th>
                <th>k = x·y</th><th>累计手续费</th><th>交易次数</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pools.filter((p) => p.dex === d.address).map((p) => {
                const key = `${p.dex}-${p.poolId}`;
                return (
                  <PoolRows key={key} pool={p} open={expanded === key}
                    toggle={() => setExpanded(expanded === key ? null : key)} />
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      {dexes.length > 0 && <CreatePool dexes={dexes} />}
    </>
  );
}

function PoolRows({ pool: p, open, toggle }: { pool: FullPool; open: boolean; toggle: () => void }) {
  const w = useWeb3();
  const k = Number(ethers.formatEther(p.reserveA)) * Number(ethers.formatEther(p.reserveB));
  return (
    <>
      <tr>
        <td>{p.poolId}</td>
        <td><b>{pairName(w.symbols, p)}</b></td>
        <td>{fmt(p.reserveA)}</td>
        <td>{fmt(p.reserveB)}</td>
        <td>{priceOf(p).toPrecision(6)}</td>
        <td>{k.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td>{fmt(p.feeAccA)} {symOf(w.symbols, p.tokenA)} + {fmt(p.feeAccB)} {symOf(w.symbols, p.tokenB)}</td>
        <td>{p.swapCount.toString()}</td>
        <td><button onClick={toggle}>{open ? '收起' : '流动性来源'}</button></td>
      </tr>
      {open && <PoolSources pool={p} />}
    </>
  );
}
