import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';
import { findOpportunities, getAmountOut, type PoolInfo } from './lib/arbFinder';

const e = (n: number) => BigInt(n) * 10n ** 18n;
const pool = (dex: string, rA: number, rB: number): PoolInfo => ({
  dex, dexName: dex, feeBps: 30n, poolId: 0, tokenA: '0xA', tokenB: '0xB', reserveA: e(rA), reserveB: e(rB),
});

test('renders the DEX title and tabs', () => {
  render(<App />);
  expect(screen.getByText(/MiniDEX/)).toBeInTheDocument();
  expect(screen.getByText('套利')).toBeInTheDocument();
});

test('getAmountOut matches the constant product formula with fee', () => {
  const p = pool('d1', 100, 100);
  const amountIn = e(10);
  expect(getAmountOut(p, '0xA', amountIn)).toBe((amountIn * 9970n * e(100)) / (e(100) * 10000n + amountIn * 9970n));
});

test('finds a profitable cross-DEX arbitrage when prices differ', () => {
  const ops = findOpportunities([pool('d1', 100, 100), pool('d2', 100, 120)]);
  expect(ops.length).toBeGreaterThan(0);
  expect(ops[0].profit > 0n).toBe(true);
  // 在 d1 用 B 买入便宜的 A，再到 d2 卖出
  expect(ops[0].steps[0].pool.dex).toBe('d1');
  expect(ops[0].startToken).toBe('0xB');
});

test('finds nothing when prices are equal', () => {
  expect(findOpportunities([pool('d1', 100, 100), pool('d2', 200, 200)])).toHaveLength(0);
});

test('errorMessage decodes token custom errors bubbled up through the DEX', async () => {
  const { ethers } = await import('ethers');
  const { abis, errorMessage } = await import('./lib/web3');
  const token = new ethers.Interface(abis.token);
  const data = token.encodeErrorResult('ERC20InsufficientBalance', [ethers.ZeroAddress, 0n, 100n * 10n ** 18n]);
  // ethers 预估 gas 时的错误形状
  const estimateErr = { code: 'CALL_EXCEPTION', data, reason: null, shortMessage: 'execution reverted (unknown custom error)' };
  expect(errorMessage(estimateErr)).toContain('代币余额不足：需要 100，当前余额 0');
  // MetaMask 包在内层的错误形状
  expect(errorMessage({ info: { error: { data: { data } } } })).toContain('ERC20InsufficientBalance');
  // 普通 require 字符串保持原样
  const strData = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['MiniDEX: slippage exceeded']);
  expect(errorMessage({ data: '0x08c379a0' + strData.slice(2) })).toBe('MiniDEX: slippage exceeded');
});
