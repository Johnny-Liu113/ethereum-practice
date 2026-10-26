// 模拟多个用户在两个交易所随机交易、添加/撤销流动性，并由套利者自动套利。
//
// 环境变量：
//   USERS=20        模拟用户数量
//   ROUNDS=150      随机操作次数
//   ARB_EVERY=10    每隔多少次操作让套利者扫描一次（0 表示不套利）
//   USER_ETH=2      每个模拟用户获得的 ETH
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpportunities, priceOf, type PoolInfo, type Opportunity } from "./arbFinder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERS = Number(process.env.USERS ?? 20);
const ROUNDS = Number(process.env.ROUNDS ?? 150);
const ARB_EVERY = Number(process.env.ARB_EVERY ?? 10);
const USER_ETH = process.env.USER_ETH ?? "2";

const connection = await hre.network.create();
const { ethers } = connection;
const ETH = ethers.ZeroAddress;
const fmt = (v: bigint, d = 4) => Number(ethers.formatEther(v)).toFixed(d);
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(arr: T[]): T => arr[rand(arr.length)];

const deploymentFile = path.resolve(__dirname, "..", "deployments", `${connection.networkName}.json`);
if (!fs.existsSync(deploymentFile)) {
  throw new Error(`找不到 ${deploymentFile}，请先运行部署脚本`);
}
const dep = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

const [deployer] = await ethers.getSigners();
const tokens = await Promise.all(
  [dep.tokenA, dep.tokenB, dep.tokenC].map((a: string) => ethers.getContractAt("TestToken", a)),
);
const symbols: Record<string, string> = { [ETH]: "ETH" };
for (const t of tokens) symbols[(await t.getAddress()).toLowerCase()] = await t.symbol();
const sym = (a: string) => symbols[a.toLowerCase()] ?? a.slice(0, 8);
const tokenByAddr = (a: string) => tokens.find((t) => t.target.toString().toLowerCase() === a.toLowerCase())!;

const dexes = await Promise.all(
  [dep.dexAlpha, dep.dexBeta].map((a: string) => ethers.getContractAt("MiniDEX", a)),
);
const faucet = await ethers.getContractAt("EthFaucet", dep.ethFaucet);
const arbitrage = await ethers.getContractAt("Arbitrage", dep.arbitrage);

async function loadPools(): Promise<PoolInfo[]> {
  const result: PoolInfo[] = [];
  for (const dex of dexes) {
    const [dexName, feeBps, pools] = await Promise.all([dex.dexName(), dex.feeBps(), dex.getAllPools()]);
    pools.forEach((p: any, i: number) =>
      result.push({
        dex: dex.target.toString(), dexName, feeBps, poolId: i,
        tokenA: p.tokenA, tokenB: p.tokenB, reserveA: p.reserveA, reserveB: p.reserveB,
      }),
    );
  }
  return result;
}

const balanceOf = async (token: string, who: string) =>
  token === ETH ? ethers.provider.getBalance(who) : tokenByAddr(token).balanceOf(who);

// ---------------------------------------------------------------------------
// 1. 创建模拟用户：从部署者处获得 ETH，领取代币，并授权给交易所和套利合约
// ---------------------------------------------------------------------------
console.log(`Creating ${USERS} simulated users + 1 arbitrageur on ${connection.networkName}...`);
const wallets = Array.from({ length: USERS + 1 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
const users = wallets.slice(0, USERS);
const arbitrageur = wallets[USERS];

for (const [i, w] of wallets.entries()) {
  await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther(USER_ETH) })).wait();
  for (const t of tokens) {
    await (await t.connect(w).faucet()).wait();
    for (const spender of [...dexes.map((d) => d.target), arbitrage.target]) {
      await (await t.connect(w).approve(spender, ethers.MaxUint256)).wait();
    }
  }
  if (i === USERS) await (await faucet.connect(w).claim()).wait(); // 套利者再领 1 ETH
}
console.log("Users ready.\n");

// ---------------------------------------------------------------------------
// 2. 随机操作
// ---------------------------------------------------------------------------
const stats = { swap: 0, add: 0, remove: 0, faucet: 0, arb: 0, failed: 0 };
const arbStart: Record<string, bigint> = {};
for (const t of [ETH, ...tokens.map((t) => t.target.toString())]) arbStart[t] = await balanceOf(t, arbitrageur.address);

async function randomSwap(user: (typeof users)[number]) {
  const pool = pick(await loadPools());
  const tokenIn = Math.random() < 0.5 ? pool.tokenA : pool.tokenB;
  const reserveIn = tokenIn === pool.tokenA ? pool.reserveA : pool.reserveB;
  // 交易量为储备的 0.5% ~ 4%，不同用户在不同交易所的交易会让价格偏离
  let amountIn = (reserveIn * BigInt(50 + rand(350))) / 10000n;
  const bal = await balanceOf(tokenIn, user.address);
  const cap = tokenIn === ETH ? bal / 2n : bal;
  if (amountIn > cap) amountIn = cap;
  if (amountIn === 0n) return;
  const dex = dexes.find((d) => d.target === pool.dex)!;
  const quoted = await dex.getAmountOut(pool.poolId, tokenIn, amountIn);
  const minOut = (quoted * 99n) / 100n; // 1% 滑点
  await (await dex.connect(user).swap(pool.poolId, tokenIn, amountIn, minOut, {
    value: tokenIn === ETH ? amountIn : 0n,
  })).wait();
  stats.swap++;
  console.log(
    `[swap]   ${user.address.slice(0, 8)} ${pool.dexName}#${pool.poolId} ` +
    `${fmt(amountIn)} ${sym(tokenIn)} -> ${fmt(quoted)} ${sym(tokenIn === pool.tokenA ? pool.tokenB : pool.tokenA)}`,
  );
}

async function randomAdd(user: (typeof users)[number]) {
  const pool = pick(await loadPools());
  const dex = dexes.find((d) => d.target === pool.dex)!;
  // 注入储备的 1% ~ 5%
  const pct = BigInt(100 + rand(400));
  let amountA = (pool.reserveA * pct) / 10000n;
  let amountB = (pool.reserveB * pct) / 10000n;
  const balA = await balanceOf(pool.tokenA, user.address);
  const balB = await balanceOf(pool.tokenB, user.address);
  const capA = pool.tokenA === ETH ? balA / 2n : balA;
  const capB = pool.tokenB === ETH ? balB / 2n : balB;
  if (amountA > capA || amountB > capB) {
    // 余额不足时按比例缩小
    const scale = Math.min(Number((capA * 1000n) / (amountA || 1n)), Number((capB * 1000n) / (amountB || 1n)));
    amountA = (amountA * BigInt(scale)) / 1000n;
    amountB = (amountB * BigInt(scale)) / 1000n;
  }
  if (amountA === 0n || amountB === 0n) return;
  const value = pool.tokenA === ETH ? amountA : pool.tokenB === ETH ? amountB : 0n;
  await (await dex.connect(user).addLiquidity(pool.poolId, amountA, amountB, { value })).wait();
  stats.add++;
  console.log(
    `[add]    ${user.address.slice(0, 8)} ${pool.dexName}#${pool.poolId} ` +
    `${fmt(amountA)} ${sym(pool.tokenA)} + ${fmt(amountB)} ${sym(pool.tokenB)}`,
  );
}

async function randomRemove(user: (typeof users)[number]) {
  for (const dex of [...dexes].sort(() => Math.random() - 0.5)) {
    const [ids, infos] = await dex.getPositionsOf(user.address);
    if (ids.length === 0) continue;
    const i = rand(ids.length);
    const [va, vb] = await dex.positionValue(ids[i]);
    await (await dex.connect(user).removeLiquidity(ids[i])).wait();
    stats.remove++;
    const pool = await dex.getPool(infos[i].poolId);
    console.log(
      `[remove] ${user.address.slice(0, 8)} ${await dex.dexName()} NFT#${ids[i]} ` +
      `deposited ${fmt(infos[i].amountA)}/${fmt(infos[i].amountB)} -> ` +
      `got ${fmt(va)} ${sym(pool.tokenA)} + ${fmt(vb)} ${sym(pool.tokenB)}`,
    );
    return;
  }
  await randomAdd(user); // 没有 NFT 就改为添加流动性
}

function describe(op: Opportunity) {
  return op.steps.map((s) => `${s.pool.dexName}#${s.pool.poolId}(${sym(s.tokenIn)}→)`).join(" ");
}

async function runArbitrage() {
  const pools = await loadPools();
  const balances: Record<string, bigint> = {};
  for (const t of Object.keys(arbStart)) balances[t.toLowerCase()] = await balanceOf(t, arbitrageur.address);
  const ops = findOpportunities(pools, (t) => {
    const b = balances[t.toLowerCase()] ?? 0n;
    return t === ETH ? b / 2n : b;
  });
  // 利润率至少 0.1% 才执行
  const op = ops.find((o) => o.profitBps >= 10);
  if (!op) {
    console.log("[arb]    no profitable opportunity");
    return;
  }
  const before = op.steps.map((s) => priceOf(s.pool));
  const steps = op.steps.map((s) => ({ dex: s.pool.dex, poolId: s.pool.poolId, tokenIn: s.tokenIn }));
  const balBefore = await balanceOf(op.startToken, arbitrageur.address);
  try {
    // 链上真实利润可能因舍入略有差异，最低利润设为预估的一半
    const tx = await arbitrage.connect(arbitrageur).executeArbitrage(steps, op.amountIn, op.profit / 2n, {
      value: op.startToken === ETH ? op.amountIn : 0n,
    });
    const receipt = await tx.wait();
    const after = (await loadPools()).filter((p) => op.steps.some((s) => s.pool.dex === p.dex && s.pool.poolId === p.poolId));
    stats.arb++;
    let realized = (await balanceOf(op.startToken, arbitrageur.address)) - balBefore;
    if (op.startToken === ETH) realized += receipt!.gasUsed * receipt!.gasPrice; // 计算不含 gas 的利润
    console.log(`[arb]  ✔ ${describe(op)}`);
    console.log(
      `         in ${fmt(op.amountIn)} ${sym(op.startToken)}  out ${fmt(op.amountOut)}  ` +
      `profit ${fmt(realized, 6)} ${sym(op.startToken)} (${(op.profitBps / 100).toFixed(2)}%)`,
    );
    op.steps.forEach((s, i) => {
      const p = after.find((x) => x.dex === s.pool.dex && x.poolId === s.pool.poolId)!;
      console.log(
        `         price ${s.pool.dexName}#${s.pool.poolId} ${sym(p.tokenA)}/${sym(p.tokenB)}: ` +
        `${before[i].toFixed(4)} -> ${priceOf(p).toFixed(4)}`,
      );
    });
  } catch (err: any) {
    stats.failed++;
    console.log(`[arb]  ✘ reverted: ${err.shortMessage ?? err.message}`);
  }
}

for (let round = 1; round <= ROUNDS; round++) {
  const user = pick(users);
  const r = Math.random();
  try {
    if (r < 0.6) await randomSwap(user);
    else if (r < 0.8) await randomAdd(user);
    else if (r < 0.92) await randomRemove(user);
    else {
      await (await pick(tokens).connect(user).faucet()).wait();
      stats.faucet++;
      console.log(`[faucet] ${user.address.slice(0, 8)} claimed tokens`);
    }
  } catch (err: any) {
    stats.failed++;
    console.log(`[error]  ${err.shortMessage ?? err.message}`);
  }
  if (ARB_EVERY > 0 && round % ARB_EVERY === 0) await runArbitrage();
}

// ---------------------------------------------------------------------------
// 3. 汇总
// ---------------------------------------------------------------------------
console.log("\n========== Summary ==========");
console.log(stats);
for (const dex of dexes) {
  const name = await dex.dexName();
  const pools = await dex.getAllPools();
  for (const [i, p] of pools.entries()) {
    const [ids] = await dex.getPoolPositions(i);
    console.log(
      `${name}#${i} ${sym(p.tokenA)}/${sym(p.tokenB)} reserves ${fmt(p.reserveA)} / ${fmt(p.reserveB)} ` +
      `price ${(Number(p.reserveB) / Number(p.reserveA)).toFixed(4)} swaps ${p.swapCount} ` +
      `fees ${fmt(p.feeAccA)} ${sym(p.tokenA)} + ${fmt(p.feeAccB)} ${sym(p.tokenB)} LPs ${ids.length}`,
    );
  }
}
console.log(`\nArbitrageur ${arbitrageur.address} balance change:`);
for (const [t, start] of Object.entries(arbStart)) {
  const now = await balanceOf(t, arbitrageur.address);
  console.log(`  ${sym(t)}: ${fmt(start)} -> ${fmt(now)} (${now >= start ? "+" : ""}${fmt(now - start, 6)})`);
}
