import { ethers } from 'ethers';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ADDRESSES, abis, formatTime, shortAddr, useWeb3 } from '../lib/web3';

// 简易区块浏览器：读取最近的区块和交易，用合约 ABI 解码函数调用和事件。

const ifaces = {
  token: new ethers.Interface(abis.token),
  dex: new ethers.Interface(abis.dex),
  arbitrage: new ethers.Interface(abis.arbitrage),
  faucet: new ethers.Interface(abis.faucet),
};
const allIfaces = Object.values(ifaces);

/** 已知合约地址 => 名称和对应的 ABI */
const KNOWN: Record<string, { name: string; iface: ethers.Interface }> = {
  [ADDRESSES.tokenA.toLowerCase()]: { name: 'TKA 代币', iface: ifaces.token },
  [ADDRESSES.tokenB.toLowerCase()]: { name: 'TKB 代币', iface: ifaces.token },
  [ADDRESSES.tokenC.toLowerCase()]: { name: 'TKC 代币', iface: ifaces.token },
  [ADDRESSES.ethFaucet.toLowerCase()]: { name: 'ETH 水龙头', iface: ifaces.faucet },
  [ADDRESSES.dexAlpha.toLowerCase()]: { name: 'DEX Alpha', iface: ifaces.dex },
  [ADDRESSES.dexBeta.toLowerCase()]: { name: 'DEX Beta', iface: ifaces.dex },
  [ADDRESSES.arbitrage.toLowerCase()]: { name: '套利合约', iface: ifaces.arbitrage },
};

const BLOCK_COUNT = 30;

interface DecodedEvent {
  contract: string;
  name: string;
  args: [string, string][];
}

interface TxRow {
  hash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  to: string | null;
  value: bigint;
  action: string;
  args: [string, string][];
  ok: boolean;
  gasUsed: bigint;
  events: DecodedEvent[];
}

interface BlockRow {
  number: number;
  hash: string;
  timestamp: number;
  gasUsed: bigint;
  txs: TxRow[];
}

function nameOf(addr: string | null, me: string): string {
  if (!addr) return '（部署合约）';
  if (addr === ethers.ZeroAddress) return 'ETH / 零地址';
  if (addr.toLowerCase() === me.toLowerCase()) return `${shortAddr(addr)}（我）`;
  return KNOWN[addr.toLowerCase()]?.name ?? shortAddr(addr);
}

/** 把解码出的参数转成可读文字：地址显示名称，大整数按 18 位精度换算 */
function formatValue(v: unknown, me: string): string {
  if (typeof v === 'bigint') {
    return v >= 10n ** 12n ? `${ethers.formatEther(v)}` : v.toString();
  }
  if (typeof v === 'string' && ethers.isAddress(v)) return nameOf(v, me);
  if (Array.isArray(v)) return `[${v.map((x) => formatValue(x, me)).join(', ')}]`;
  return String(v);
}

function namedArgs(fragment: ethers.Fragment & { inputs: readonly ethers.ParamType[] }, values: ethers.Result, me: string) {
  return fragment.inputs.map((p, i): [string, string] => [p.name || `arg${i}`, formatValue(values[i], me)]);
}

function decodeTx(tx: ethers.TransactionResponse, me: string): { action: string; args: [string, string][] } {
  if (!tx.to) return { action: '部署合约', args: [] };
  if (tx.data === '0x') return { action: 'ETH 转账', args: [] };
  const known = KNOWN[tx.to.toLowerCase()];
  for (const iface of known ? [known.iface] : allIfaces) {
    try {
      const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
      if (parsed) return { action: parsed.name, args: namedArgs(parsed.fragment, parsed.args, me) };
    } catch {
      /* 尝试下一个 ABI */
    }
  }
  return { action: `未知调用 ${tx.data.slice(0, 10)}`, args: [] };
}

function decodeLogs(logs: readonly ethers.Log[], me: string): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  for (const log of logs) {
    const known = KNOWN[log.address.toLowerCase()];
    for (const iface of known ? [known.iface] : allIfaces) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) {
          events.push({
            contract: nameOf(log.address, me),
            name: parsed.name,
            args: namedArgs(parsed.fragment, parsed.args, me),
          });
          break;
        }
      } catch {
        /* 尝试下一个 ABI */
      }
    }
  }
  return events;
}

export default function ExplorerPanel() {
  const w = useWeb3();
  const cache = useRef(new Map<number, BlockRow>());
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [onlyMine, setOnlyMine] = useState(false);
  const [hideApprove, setHideApprove] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  // 切换账户后，“（我）”的标记需要重新计算
  useEffect(() => { cache.current.clear(); }, [w.address]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const latest = await w.provider.getBlockNumber();
      const numbers = Array.from({ length: Math.min(BLOCK_COUNT, latest + 1) }, (_, i) => latest - i);
      const rows = await Promise.all(numbers.map(async (n): Promise<BlockRow> => {
        const hit = cache.current.get(n);
        if (hit) return hit;
        const block = await w.provider.getBlock(n, true);
        if (!block) throw new Error(`block ${n} not found`);
        const txs = await Promise.all(block.prefetchedTransactions.map(async (tx): Promise<TxRow> => {
          const receipt = await w.provider.getTransactionReceipt(tx.hash);
          return {
            hash: tx.hash,
            blockNumber: n,
            timestamp: block.timestamp,
            from: tx.from,
            to: tx.to,
            value: tx.value,
            ...decodeTx(tx, w.address),
            ok: receipt?.status === 1,
            gasUsed: receipt?.gasUsed ?? 0n,
            events: receipt ? decodeLogs(receipt.logs, w.address) : [],
          };
        }));
        const row = { number: n, hash: block.hash ?? '', timestamp: block.timestamp, gasUsed: block.gasUsed, txs };
        cache.current.set(n, row);
        return row;
      }));
      if (!cancelled) setBlocks(rows);
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [w.provider, w.address, w.version]);

  const me = w.address.toLowerCase();
  const txs = blocks.flatMap((b) => b.txs).filter((t) =>
    (!onlyMine || t.from.toLowerCase() === me) && (!hideApprove || t.action !== 'approve'));

  return (
    <>
      <section className="card">
        <h2>最近的交易</h2>
        <div className="form">
          <label className="inline">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
            只看当前账户
          </label>
          <label className="inline">
            <input type="checkbox" checked={hideApprove} onChange={(e) => setHideApprove(e.target.checked)} />
            隐藏授权（approve）交易
          </label>
          <span className="muted">显示最近 {BLOCK_COUNT} 个区块，点击一行查看函数参数和事件。</span>
        </div>
        {txs.length === 0 ? (
          <p className="muted">暂无交易。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>区块</th><th>时间</th><th>交易哈希</th><th>发送者</th><th>目标合约</th>
                <th>调用函数</th><th>ETH</th><th>Gas</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <Fragment key={t.hash}>
                  <tr className={`clickable ${t.from.toLowerCase() === me ? 'mine' : ''}`}
                    onClick={() => setExpanded(expanded === t.hash ? null : t.hash)}>
                    <td>#{t.blockNumber}</td>
                    <td>{formatTime(BigInt(t.timestamp))}</td>
                    <td><code title={t.hash}>{shortAddr(t.hash)}</code></td>
                    <td title={t.from}>{nameOf(t.from, w.address)}</td>
                    <td title={t.to ?? ''}>{nameOf(t.to, w.address)}</td>
                    <td><b>{t.action}</b></td>
                    <td>{t.value > 0n ? ethers.formatEther(t.value) : ''}</td>
                    <td>{t.gasUsed.toString()}</td>
                    <td className={t.ok ? 'pos' : 'neg'}>{t.ok ? '成功' : '失败（已回滚）'}</td>
                  </tr>
                  {expanded === t.hash && (
                    <tr className="sub">
                      <td colSpan={9}>
                        <p><b>交易哈希：</b><code>{t.hash}</code></p>
                        <p><b>发送者：</b><code>{t.from}</code>　<b>目标：</b><code>{t.to ?? '（部署合约）'}</code></p>
                        {t.args.length > 0 && (
                          <>
                            <b>函数参数</b>
                            <table className="kv">
                              <tbody>
                                {t.args.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
                              </tbody>
                            </table>
                          </>
                        )}
                        <b>事件（Event）</b>
                        {t.events.length === 0 ? (
                          <p className="muted">{t.ok ? '无事件' : '交易失败，所有状态变化和事件都已回滚'}</p>
                        ) : (
                          <table>
                            <thead><tr><th>合约</th><th>事件</th><th>内容</th></tr></thead>
                            <tbody>
                              {t.events.map((ev, i) => (
                                <tr key={i}>
                                  <td>{ev.contract}</td>
                                  <td><b>{ev.name}</b></td>
                                  <td>{ev.args.map(([k, v]) => <div key={k}>{k}: {v}</div>)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>最近的区块</h2>
        <table>
          <thead><tr><th>区块号</th><th>时间</th><th>区块哈希</th><th>交易数</th><th>Gas 用量</th></tr></thead>
          <tbody>
            {blocks.map((b) => (
              <tr key={b.number}>
                <td>#{b.number}</td>
                <td>{formatTime(BigInt(b.timestamp))}</td>
                <td><code title={b.hash}>{shortAddr(b.hash)}</code></td>
                <td>{b.txs.length}</td>
                <td>{b.gasUsed.toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Hardhat 节点默认“自动挖矿”：每发送一笔交易就立即打包成一个新区块，所以通常一个区块只有一笔交易。
        </p>
      </section>
    </>
  );
}
