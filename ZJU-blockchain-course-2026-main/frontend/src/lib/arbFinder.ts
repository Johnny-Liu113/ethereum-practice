// 套利机会搜索（纯 TypeScript，不依赖 ethers），模拟脚本和前端共用同一份逻辑。
// 此文件复制自 contracts/scripts/arbFinder.ts，修改时请保持一致。

export interface PoolInfo {
  dex: string;        // 交易所合约地址
  dexName: string;
  feeBps: bigint;
  poolId: number;
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
}

export interface PathStep {
  pool: PoolInfo;
  tokenIn: string;
}

export interface Opportunity {
  steps: PathStep[];
  startToken: string;
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  /** 利润率（万分之一） */
  profitBps: number;
}

const FEE_DENOMINATOR = 10000n;

export function otherToken(pool: PoolInfo, token: string): string {
  return same(pool.tokenA, token) ? pool.tokenB : pool.tokenA;
}

export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function hasToken(pool: PoolInfo, token: string): boolean {
  return same(pool.tokenA, token) || same(pool.tokenB, token);
}

/** 与合约 _getAmountOut 完全相同的恒定乘积公式（含手续费） */
export function getAmountOut(pool: PoolInfo, tokenIn: string, amountIn: bigint): bigint {
  const aToB = same(pool.tokenA, tokenIn);
  const reserveIn = aToB ? pool.reserveA : pool.reserveB;
  const reserveOut = aToB ? pool.reserveB : pool.reserveA;
  if (reserveIn === 0n || reserveOut === 0n || amountIn <= 0n) return 0n;
  const amountInWithFee = amountIn * (FEE_DENOMINATOR - pool.feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

export function simulatePath(steps: PathStep[], amountIn: bigint): bigint {
  let amount = amountIn;
  for (const s of steps) amount = getAmountOut(s.pool, s.tokenIn, amount);
  return amount;
}

/** 价格：1 个 tokenA 值多少 tokenB */
export function priceOf(pool: PoolInfo): number {
  if (pool.reserveA === 0n) return 0;
  return Number((pool.reserveB * 10n ** 18n) / pool.reserveA) / 1e18;
}

/**
 * 利润 f(x) = simulatePath(x) - x 是凹函数，用三分搜索找到最佳投入量。
 * maxIn 为投入上限（例如套利者余额）。
 */
export function optimizeAmount(steps: PathStep[], maxIn: bigint): { amountIn: bigint; amountOut: bigint } {
  const profit = (x: bigint) => simulatePath(steps, x) - x;
  let lo = 0n;
  let hi = maxIn;
  for (let i = 0; i < 200 && hi - lo > 2n; i++) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    if (profit(m1) < profit(m2)) lo = m1;
    else hi = m2;
  }
  const amountIn = (lo + hi) / 2n;
  return { amountIn, amountOut: simulatePath(steps, amountIn) };
}

/** 枚举所有 2 步（跨交易所同代币对）和 3 步（三角）环路 */
export function enumerateCycles(pools: PoolInfo[]): PathStep[][] {
  const cycles: PathStep[][] = [];
  for (const p of pools) {
    for (const start of [p.tokenA, p.tokenB]) {
      const mid = otherToken(p, start);
      for (const q of pools) {
        if (q === p || !hasToken(q, mid)) continue;
        const next = otherToken(q, mid);
        // 两步环路：start -> mid (p)，mid -> start (q)
        if (same(next, start)) {
          cycles.push([{ pool: p, tokenIn: start }, { pool: q, tokenIn: mid }]);
          continue;
        }
        // 三步环路：start -> mid (p)，mid -> next (q)，next -> start (r)
        for (const r of pools) {
          if (r === p || r === q || !hasToken(r, next)) continue;
          if (same(otherToken(r, next), start)) {
            cycles.push([
              { pool: p, tokenIn: start },
              { pool: q, tokenIn: mid },
              { pool: r, tokenIn: next },
            ]);
          }
        }
      }
    }
  }
  return cycles;
}

/**
 * 搜索当前所有有利可图的套利机会，按利润率从高到低排序。
 * @param maxInFor 返回某个起始代币允许投入的最大数量（例如余额），返回 undefined 则使用池子储备的一半
 */
export function findOpportunities(
  pools: PoolInfo[],
  maxInFor?: (token: string) => bigint | undefined,
): Opportunity[] {
  const result: Opportunity[] = [];
  for (const steps of enumerateCycles(pools)) {
    const first = steps[0];
    const startToken = first.tokenIn;
    const reserveIn = same(first.pool.tokenA, startToken) ? first.pool.reserveA : first.pool.reserveB;
    let maxIn = reserveIn / 2n;
    const limit = maxInFor?.(startToken);
    if (limit !== undefined && limit < maxIn) maxIn = limit;
    if (maxIn <= 0n) continue;

    const { amountIn, amountOut } = optimizeAmount(steps, maxIn);
    const profit = amountOut - amountIn;
    if (amountIn === 0n || profit <= 0n) continue;
    result.push({
      steps,
      startToken,
      amountIn,
      amountOut,
      profit,
      profitBps: Number((profit * 10000n) / amountIn),
    });
  }
  return result.sort((x, y) => y.profitBps - x.profitBps);
}
