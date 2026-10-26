import { ethers } from 'ethers';
import { createContext, useContext } from 'react';
import addresses from '../contracts/addresses.json';
import TestTokenAbi from '../contracts/abis/TestToken.json';
import EthFaucetAbi from '../contracts/abis/EthFaucet.json';
import MiniDEXAbi from '../contracts/abis/MiniDEX.json';
import ArbitrageAbi from '../contracts/abis/Arbitrage.json';
import type { PoolInfo } from './arbFinder';

export const ETH = ethers.ZeroAddress;
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545';
export const ADDRESSES = addresses;
export const KNOWN_TOKENS = [ETH, addresses.tokenA, addresses.tokenB, addresses.tokenC];
export const DEX_ADDRESSES = [addresses.dexAlpha, addresses.dexBeta];

export const abis = {
  token: TestTokenAbi.abi,
  faucet: EthFaucetAbi.abi,
  dex: MiniDEXAbi.abi,
  arbitrage: ArbitrageAbi.abi,
};

export interface DexMeta {
  address: string;
  name: string;
  feeBps: bigint;
}

export interface FullPool extends PoolInfo {
  totalLiquidity: bigint;
  feeAccA: bigint;
  feeAccB: bigint;
  swapCount: bigint;
  createdTimestamp: bigint;
  creator: string;
}

export interface Web3State {
  provider: ethers.Provider;
  signer: ethers.Signer;
  address: string;
  /** 每次交易成功后自增，各面板据此刷新数据 */
  version: number;
  refresh: () => void;
  /** 统一的交易执行入口：显示状态、等待确认、刷新数据 */
  sendTx: (label: string, fn: () => Promise<ethers.ContractTransactionResponse | ethers.TransactionResponse>) =>
    Promise<ethers.TransactionReceipt | null>;
  symbols: Record<string, string>;
  ensureSymbols: (tokens: string[]) => void;
}

export const Web3Context = createContext<Web3State | null>(null);

export function useWeb3(): Web3State {
  const ctx = useContext(Web3Context);
  if (!ctx) throw new Error('Web3Context missing');
  return ctx;
}

export const tokenContract = (addr: string, runner: ethers.ContractRunner) =>
  new ethers.Contract(addr, abis.token, runner);
export const dexContract = (addr: string, runner: ethers.ContractRunner) =>
  new ethers.Contract(addr, abis.dex, runner);
export const faucetContract = (runner: ethers.ContractRunner) =>
  new ethers.Contract(addresses.ethFaucet, abis.faucet, runner);
export const arbitrageContract = (runner: ethers.ContractRunner) =>
  new ethers.Contract(addresses.arbitrage, abis.arbitrage, runner);

export async function loadDexes(provider: ethers.Provider): Promise<DexMeta[]> {
  return Promise.all(
    DEX_ADDRESSES.map(async (address) => {
      const dex = dexContract(address, provider);
      const [name, feeBps] = await Promise.all([dex.dexName(), dex.feeBps()]);
      return { address, name, feeBps };
    }),
  );
}

export async function loadPools(provider: ethers.Provider, dexes?: DexMeta[]): Promise<FullPool[]> {
  const metas = dexes ?? (await loadDexes(provider));
  const all = await Promise.all(
    metas.map(async (m) => {
      const pools = await dexContract(m.address, provider).getAllPools();
      return pools.map((p: any, i: number): FullPool => ({
        dex: m.address,
        dexName: m.name,
        feeBps: m.feeBps,
        poolId: i,
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        reserveA: p.reserveA,
        reserveB: p.reserveB,
        totalLiquidity: p.totalLiquidity,
        feeAccA: p.feeAccA,
        feeAccB: p.feeAccB,
        swapCount: p.swapCount,
        createdTimestamp: p.createdTimestamp,
        creator: p.creator,
      }));
    }),
  );
  return all.flat();
}

export async function balanceOf(provider: ethers.Provider, token: string, who: string): Promise<bigint> {
  if (token === ETH) return provider.getBalance(who);
  return tokenContract(token, provider).balanceOf(who);
}

/** 确保 spender 对 token 有足够授权，不足则发起 approve（ETH 无需授权） */
export async function ensureAllowance(
  state: Web3State, token: string, spender: string, amount: bigint,
): Promise<void> {
  if (token === ETH) return;
  const t = tokenContract(token, state.signer);
  const allowance: bigint = await t.allowance(state.address, spender);
  if (allowance >= amount) return;
  await state.sendTx(`授权 ${state.symbols[token.toLowerCase()] ?? token}`, () =>
    t.approve(spender, ethers.MaxUint256),
  );
}

export function fmt(v: bigint | undefined, digits = 4): string {
  if (v === undefined) return '-';
  const n = Number(ethers.formatEther(v));
  if (n !== 0 && Math.abs(n) < 10 ** -digits) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function parse(v: string): bigint {
  try {
    return v.trim() === '' ? 0n : ethers.parseEther(v.trim());
  } catch {
    return 0n;
  }
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function formatTime(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString();
}

// 合并所有合约的 custom error 定义。代币合约抛出的错误（例如余额不足）会冒泡到
// 交易所合约的调用里，只用交易所的 ABI 无法识别，所以要用全部 ABI 一起解析。
const errorIface = new ethers.Interface([...abis.token, ...abis.dex, ...abis.arbitrage].filter((f: any) => f.type === 'error'));

function findRevertData(err: any): string | undefined {
  const candidates = [err?.data, err?.info?.error?.data, err?.error?.data, err?.info?.error?.data?.data, err?.error?.data?.data];
  return candidates.find((d): d is string => typeof d === 'string' && d.startsWith('0x') && d.length >= 10);
}

function decodeCustomError(err: any): string | undefined {
  const data = findRevertData(err);
  if (!data) return undefined;
  let parsed: ethers.ErrorDescription | null = null;
  try {
    parsed = errorIface.parseError(data);
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  const a = parsed.args;
  switch (parsed.name) {
    case 'Error': // require(条件, "错误信息") 的普通字符串错误
      return String(a[0]);
    case 'ERC20InsufficientBalance':
      return `代币余额不足：需要 ${fmt(a[2])}，当前余额 ${fmt(a[1])}（ERC20InsufficientBalance）`;
    case 'ERC20InsufficientAllowance':
      return `代币授权额度不足：需要 ${fmt(a[2])}，当前额度 ${fmt(a[1])}（ERC20InsufficientAllowance）`;
    default:
      return `${parsed.name}(${a.map((x: unknown) => String(x)).join(', ')})`;
  }
}

export function errorMessage(err: any): string {
  const custom = decodeCustomError(err);
  if (custom) return custom;
  if (err?.reason) return err.reason;
  // 节点直接拒绝交易时（例如 revert），ethers 无法归类，真正的原因在内层 error 中
  const inner = err?.info?.error?.message ?? err?.error?.message;
  if (inner && (!err?.shortMessage || err.shortMessage.includes('coalesce'))) return inner;
  return err?.shortMessage ?? err?.message ?? String(err);
}

export function symOf(symbols: Record<string, string>, token: string): string {
  return symbols[token.toLowerCase()] ?? shortAddr(token);
}

export function pairName(symbols: Record<string, string>, p: { tokenA: string; tokenB: string }): string {
  return `${symOf(symbols, p.tokenA)}/${symOf(symbols, p.tokenB)}`;
}
