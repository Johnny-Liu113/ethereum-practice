import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FRONTEND_CONTRACTS = path.resolve(ROOT, "../frontend/src/contracts");

async function main() {
  const connection = await hre.network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const e = (n: string | number) => ethers.parseEther(String(n));
  const ETH = ethers.ZeroAddress;
  console.log(`Network: ${connection.networkName}, deployer: ${deployer.address}`);

  // 1. ERC20 测试代币
  const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]);
  const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]);
  const tokenC = await ethers.deployContract("TestToken", ["Token C", "TKC"]);
  // 2. ETH 水龙头
  const faucet = await ethers.deployContract("EthFaucet");
  // 3. 两个交易所（Bonus 1）：手续费不同
  const dexAlpha = await ethers.deployContract("MiniDEX", ["DEX Alpha", "ALP", 30]);
  const dexBeta = await ethers.deployContract("MiniDEX", ["DEX Beta", "BLP", 25]);
  // 4. 套利合约（Bonus 2）
  const arbitrage = await ethers.deployContract("Arbitrage");
  for (const c of [tokenA, tokenB, tokenC, faucet, dexAlpha, dexBeta, arbitrage]) {
    await c.waitForDeployment();
  }

  const addr = {
    tokenA: await tokenA.getAddress(),
    tokenB: await tokenB.getAddress(),
    tokenC: await tokenC.getAddress(),
    ethFaucet: await faucet.getAddress(),
    dexAlpha: await dexAlpha.getAddress(),
    dexBeta: await dexBeta.getAddress(),
    arbitrage: await arbitrage.getAddress(),
  };
  console.log(addr);

  // 给 ETH 水龙头注资
  const faucetEth = process.env.FAUCET_ETH ?? "50";
  await (await deployer.sendTransaction({ to: addr.ethFaucet, value: e(faucetEth) })).wait();

  // 部署者领取代币并授权给两个交易所
  for (const t of [tokenA, tokenB, tokenC]) {
    for (let i = 0; i < 5; i++) await (await t.faucet()).wait();
    await (await t.approve(addr.dexAlpha, ethers.MaxUint256)).wait();
    await (await t.approve(addr.dexBeta, ethers.MaxUint256)).wait();
  }

  // 初始池子：两个交易所对相同代币对给出不同的初始价格，形成价差
  const create = async (dex: typeof dexAlpha, a: string, b: string, amtA: string, amtB: string) => {
    const value = a === ETH ? e(amtA) : b === ETH ? e(amtB) : 0n;
    await (await dex.createPool(a, b, e(amtA), e(amtB), { value })).wait();
  };
  await create(dexAlpha, addr.tokenA, addr.tokenB, "500", "500");   // Alpha#0 A/B 1:1
  await create(dexAlpha, addr.tokenB, addr.tokenC, "500", "500");   // Alpha#1 B/C 1:1
  await create(dexAlpha, addr.tokenA, ETH, "500", "5");             // Alpha#2 A/ETH
  await create(dexAlpha, addr.tokenC, addr.tokenA, "300", "300");   // Alpha#3 C/A（可用于三角套利）
  await create(dexBeta, addr.tokenA, addr.tokenB, "500", "550");    // Beta#0  A/B 1:1.1
  await create(dexBeta, addr.tokenB, addr.tokenC, "500", "500");    // Beta#1  B/C 1:1
  await create(dexBeta, addr.tokenA, ETH, "500", "4.5");            // Beta#2  A/ETH
  console.log("Initial pools created.");

  // 输出地址和 ABI，供前端和模拟脚本使用
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployment = { network: connection.networkName, chainId, ...addr };
  fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "deployments", `${connection.networkName}.json`),
    JSON.stringify(deployment, null, 2),
  );

  fs.mkdirSync(path.join(FRONTEND_CONTRACTS, "abis"), { recursive: true });
  fs.writeFileSync(path.join(FRONTEND_CONTRACTS, "addresses.json"), JSON.stringify(deployment, null, 2));
  for (const name of ["TestToken", "EthFaucet", "MiniDEX", "Arbitrage"]) {
    const artifact = JSON.parse(
      fs.readFileSync(path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8"),
    );
    fs.writeFileSync(
      path.join(FRONTEND_CONTRACTS, "abis", `${name}.json`),
      JSON.stringify({ abi: artifact.abi }, null, 2),
    );
  }
  console.log(`Deployment info written to deployments/ and ${FRONTEND_CONTRACTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
