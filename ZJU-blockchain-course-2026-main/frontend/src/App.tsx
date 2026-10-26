import { ethers } from 'ethers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  ADDRESSES, ETH, KNOWN_TOKENS, RPC_URL, Web3Context, errorMessage, shortAddr, tokenContract,
  type Web3State,
} from './lib/web3';
import AccountPanel from './components/AccountPanel';
import PoolsPanel from './components/PoolsPanel';
import SwapPanel from './components/SwapPanel';
import LiquidityPanel from './components/LiquidityPanel';
import ArbitragePanel from './components/ArbitragePanel';
import ExplorerPanel from './components/ExplorerPanel';

declare global {
  interface Window {
    ethereum?: ethers.Eip1193Provider & {
      on?: (event: string, cb: (...args: any[]) => void) => void;
      removeListener?: (event: string, cb: (...args: any[]) => void) => void;
    };
  }
}

type Mode = 'local' | 'metamask';
const TABS = [
  { key: 'account', label: '账户 & 水龙头' },
  { key: 'pools', label: '交易池' },
  { key: 'swap', label: '交易' },
  { key: 'liquidity', label: '流动性 & NFT' },
  { key: 'arbitrage', label: '套利' },
  { key: 'explorer', label: '区块浏览器' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

interface TxStatus {
  id: number;
  kind: 'pending' | 'success' | 'error';
  text: string;
}

function App() {
  const [mode, setMode] = useState<Mode>('local');
  const [localAccounts, setLocalAccounts] = useState<ethers.JsonRpcSigner[]>([]);
  const [accountIndex, setAccountIndex] = useState(0);
  const [provider, setProvider] = useState<ethers.Provider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [connectError, setConnectError] = useState('');
  const [version, setVersion] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tab, setTab] = useState<TabKey>('account');
  const [txLog, setTxLog] = useState<TxStatus[]>([]);
  const [symbols, setSymbols] = useState<Record<string, string>>({ [ETH]: 'ETH' });
  const pendingSymbols = useRef(new Set<string>());

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // ---------------- 连接：本地节点账户 ----------------
  const connectLocal = useCallback(async () => {
    setConnectError('');
    try {
      // staticNetwork：节点未启动时立即报错，而不是无限重试
      const p = new ethers.JsonRpcProvider(RPC_URL, ADDRESSES.chainId, { staticNetwork: true });
      p.pollingInterval = 500;
      const id = Number(await p.send('eth_chainId', []));
      const accounts = await p.listAccounts();
      if (accounts.length === 0) throw new Error('节点没有可用的已解锁账户');
      setLocalAccounts(accounts);
      setProvider(p);
      setChainId(id);
    } catch (err) {
      setProvider(null);
      setSigner(null);
      setAddress('');
      setConnectError(`无法连接本地节点 ${RPC_URL}：${errorMessage(err)}`);
    }
  }, []);

  useEffect(() => {
    if (mode !== 'local' || localAccounts.length === 0) return;
    const s = localAccounts[Math.min(accountIndex, localAccounts.length - 1)];
    setSigner(s);
    setAddress(s.address);
  }, [mode, localAccounts, accountIndex]);

  // ---------------- 连接：MetaMask ----------------
  const connectMetaMask = useCallback(async () => {
    setConnectError('');
    if (!window.ethereum) {
      setConnectError('未检测到 MetaMask，请安装插件或改用“本地节点账户”模式');
      return;
    }
    try {
      const p = new ethers.BrowserProvider(window.ethereum);
      p.pollingInterval = 500;
      await p.send('eth_requestAccounts', []);
      const s = await p.getSigner();
      setProvider(p);
      setSigner(s);
      setAddress(await s.getAddress());
      setChainId(Number((await p.getNetwork()).chainId));
    } catch (err) {
      setConnectError(`MetaMask 连接失败：${errorMessage(err)}`);
    }
  }, []);

  useEffect(() => {
    setProvider(null);
    setSigner(null);
    setAddress('');
    if (mode === 'local') connectLocal();
  }, [mode, connectLocal]);

  useEffect(() => {
    if (mode !== 'metamask' || !window.ethereum?.on) return;
    const reconnect = () => connectMetaMask();
    window.ethereum.on('accountsChanged', reconnect);
    window.ethereum.on('chainChanged', reconnect);
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', reconnect);
      window.ethereum?.removeListener?.('chainChanged', reconnect);
    };
  }, [mode, connectMetaMask]);

  // 自动刷新：便于在运行模拟脚本时实时观察池子变化
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  // ---------------- 代币符号缓存 ----------------
  const ensureSymbols = useCallback((tokens: string[]) => {
    if (!provider) return;
    for (const t of tokens) {
      const key = t.toLowerCase();
      if (key === ETH || symbols[key] || pendingSymbols.current.has(key)) continue;
      pendingSymbols.current.add(key);
      tokenContract(t, provider).symbol()
        .catch(() => shortAddr(t))
        .then((s: string) => setSymbols((prev) => ({ ...prev, [key]: s })));
    }
  }, [provider, symbols]);

  useEffect(() => ensureSymbols(KNOWN_TOKENS), [ensureSymbols]);

  // ---------------- 交易执行 ----------------
  const logId = useRef(0);
  // 同一笔交易的状态原地更新（等待确认 → 成功/失败）
  const setLog = (s: TxStatus) =>
    setTxLog((prev) => [s, ...prev.filter((x) => x.id !== s.id)].slice(0, 6));
  const sendTx = useCallback<Web3State['sendTx']>(async (label, fn) => {
    const id = ++logId.current;
    const pushLog = (s: Omit<TxStatus, 'id'>) => setLog({ ...s, id });
    pushLog({ kind: 'pending', text: `${label}：等待确认…` });
    try {
      const tx = await fn();
      const receipt = await tx.wait();
      pushLog({ kind: 'success', text: `${label}：成功（区块 ${receipt?.blockNumber}，tx ${shortAddr(tx.hash)}）` });
      refresh();
      return receipt;
    } catch (err) {
      pushLog({ kind: 'error', text: `${label}：失败 —— ${errorMessage(err)}` });
      throw err;
    }
  }, [refresh]);

  const state = useMemo<Web3State | null>(() => {
    if (!provider || !signer || !address) return null;
    return { provider, signer, address, version, refresh, sendTx, symbols, ensureSymbols };
  }, [provider, signer, address, version, refresh, sendTx, symbols, ensureSymbols]);

  const wrongChain = chainId !== null && chainId !== ADDRESSES.chainId;

  // 请求 MetaMask 切换到部署合约的网络；钱包里还没有这个网络时，先帮用户添加
  const switchNetwork = async () => {
    if (!window.ethereum) return;
    const hexId = '0x' + ADDRESSES.chainId.toString(16);
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    } catch (err: any) {
      if (err?.code !== 4902) {
        setConnectError(`切换网络失败：${errorMessage(err)}`);
        return;
      }
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexId,
            chainName: 'Hardhat Local',
            rpcUrls: [RPC_URL],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          }],
        });
      } catch (addErr) {
        setConnectError(`添加网络失败：${errorMessage(addErr)}`);
      }
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>MiniDEX · AMM 去中心化交易所</h1>
        <div className="connect">
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="local">本地节点账户（多用户模拟）</option>
            <option value="metamask">MetaMask</option>
          </select>
          {mode === 'local' && localAccounts.length > 0 && (
            <select value={accountIndex} onChange={(e) => setAccountIndex(Number(e.target.value))}>
              {localAccounts.map((a, i) => (
                <option key={a.address} value={i}>用户 {i + 1}（Account #{i}）{shortAddr(a.address)}</option>
              ))}
            </select>
          )}
          {mode === 'metamask' && !address && <button onClick={connectMetaMask}>连接 MetaMask</button>}
          {mode === 'local' && !provider && <button onClick={connectLocal}>重新连接</button>}
          {address && <span className="addr" title={address}>当前账户 {shortAddr(address)}</span>}
          {chainId !== null && <span className="muted">Chain {chainId}</span>}
          <label className="muted">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            自动刷新
          </label>
          <button onClick={refresh}>刷新</button>
        </div>
      </header>

      {connectError && <div className="banner error">{connectError}</div>}
      {wrongChain && (
        <div className="banner error">
          当前网络 Chain ID 为 {chainId}，但合约部署在 Chain ID {ADDRESSES.chainId} 上，请切换网络。
          {mode === 'metamask' && (
            <button className="inline-btn" onClick={switchNetwork}>一键切换到 Hardhat Local</button>
          )}
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {txLog.length > 0 && (
        <div className="txlog">
          {txLog.map((s) => <div key={s.id} className={`tx ${s.kind}`}>{s.text}</div>)}
        </div>
      )}

      <main>
        {!state ? (
          <p className="muted">请先连接钱包或本地节点。</p>
        ) : (
          <Web3Context.Provider value={state}>
            {tab === 'account' && <AccountPanel />}
            {tab === 'pools' && <PoolsPanel />}
            {tab === 'swap' && <SwapPanel />}
            {tab === 'liquidity' && <LiquidityPanel />}
            {tab === 'arbitrage' && <ArbitragePanel />}
            {tab === 'explorer' && <ExplorerPanel />}
          </Web3Context.Provider>
        )}
      </main>
    </div>
  );
}

export default App;
