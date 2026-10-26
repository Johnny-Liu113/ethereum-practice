import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

const ETH = ethers.ZeroAddress;
const e = (n: string | number) => ethers.parseEther(String(n));

describe("MiniDEX", function () {
  async function deployFixture() {
    const [owner, alice, bob, arber] = await ethers.getSigners();
    const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]);
    const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]);
    const tokenC = await ethers.deployContract("TestToken", ["Token C", "TKC"]);
    const dex1 = await ethers.deployContract("MiniDEX", ["DEX Alpha", "ALP", 30]);
    const dex2 = await ethers.deployContract("MiniDEX", ["DEX Beta", "BLP", 30]);
    const arb = await ethers.deployContract("Arbitrage");
    const faucet = await ethers.deployContract("EthFaucet");
    await owner.sendTransaction({ to: await faucet.getAddress(), value: e(10) });

    for (const user of [owner, alice, bob, arber]) {
      for (const t of [tokenA, tokenB, tokenC]) {
        await t.connect(user).faucet();
        for (const d of [dex1, dex2, arb]) {
          await t.connect(user).approve(await d.getAddress(), ethers.MaxUint256);
        }
      }
    }
    return { owner, alice, bob, arber, tokenA, tokenB, tokenC, dex1, dex2, arb, faucet };
  }

  describe("Faucets", function () {
    it("lets users claim test tokens and ETH", async function () {
      const { alice, tokenA, faucet } = await networkHelpers.loadFixture(deployFixture);
      expect(await tokenA.balanceOf(alice.address)).to.equal(e(1000));
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await faucet.connect(alice).claim();
      const r = await tx.wait();
      const gas = r!.gasUsed * r!.gasPrice;
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + e(1) - gas);
    });
  });

  describe("Pools", function () {
    it("creates a pool with initial liquidity and mints an NFT", async function () {
      const { alice, tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      await dex1.connect(alice).createPool(await tokenA.getAddress(), await tokenB.getAddress(), e(100), e(200));
      const pool = await dex1.getPool(0);
      expect(pool.reserveA).to.equal(e(100));
      expect(pool.reserveB).to.equal(e(200));
      expect(await dex1.ownerOf(1)).to.equal(alice.address);
      expect(await dex1.getPrice(0)).to.equal(e(2));
      const pos = await dex1.positions(1);
      expect(pos.liquidity + 1000n).to.equal(pool.totalLiquidity);
    });

    it("rejects duplicate pairs (in either order)", async function () {
      const { tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      await dex1.createPool(a, b, e(10), e(10));
      await expect(dex1.createPool(b, a, e(10), e(10))).to.be.revertedWith("MiniDEX: pool exists");
    });

    it("supports ERC20/ETH pools", async function () {
      const { alice, tokenA, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      await dex1.connect(alice).createPool(a, ETH, e(100), e(1), { value: e(1) });
      const before = await ethers.provider.getBalance(alice.address);
      const out = await dex1.getAmountOut(0, ETH, e("0.1"));
      const tx = await dex1.connect(alice).swap(0, ETH, e("0.1"), out, { value: e("0.1") });
      const r = await tx.wait();
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before - e("0.1") - r!.gasUsed * r!.gasPrice);
      expect((await dex1.getPool(0)).reserveB).to.equal(e("1.1"));
    });
  });

  describe("Swap", function () {
    it("follows the constant product formula with a 0.3% fee", async function () {
      const { alice, bob, tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      await dex1.connect(alice).createPool(a, await tokenB.getAddress(), e(100), e(100));
      const amountIn = e(10);
      const expected = (amountIn * 9970n * e(100)) / (e(100) * 10000n + amountIn * 9970n);
      expect(await dex1.getAmountOut(0, a, amountIn)).to.equal(expected);

      const before = await tokenB.balanceOf(bob.address);
      await dex1.connect(bob).swap(0, a, amountIn, expected);
      expect((await tokenB.balanceOf(bob.address)) - before).to.equal(expected);
      const pool = await dex1.getPool(0);
      expect(pool.reserveA * pool.reserveB).to.be.greaterThan(e(100) * e(100)); // k 因手续费增长
      expect(pool.feeAccA).to.equal(e("0.03"));
    });

    it("reverts when slippage is exceeded", async function () {
      const { tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      await dex1.createPool(a, await tokenB.getAddress(), e(100), e(100));
      await expect(dex1.swap(0, a, e(10), e(10))).to.be.revertedWith("MiniDEX: slippage exceeded");
    });
  });

  describe("Liquidity", function () {
    it("adds liquidity at the current ratio and pays fees on removal", async function () {
      const { alice, bob, tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      await dex1.connect(alice).createPool(a, b, e(100), e(100));
      // bob 想注入 50 A + 80 B，但比例是 1:1，所以只会用掉 50 B
      await dex1.connect(bob).addLiquidity(0, e(50), e(80));
      const pos = await dex1.positions(2);
      expect(pos.amountA).to.equal(e(50));
      expect(pos.amountB).to.equal(e(50));

      const [ids, , owners] = await dex1.getPoolPositions(0);
      expect(ids).to.deep.equal([1n, 2n]);
      expect(owners).to.deep.equal([alice.address, bob.address]);

      // 来回交易产生手续费
      for (let i = 0; i < 5; i++) {
        await dex1.swap(0, a, e(20), 0);
        await dex1.swap(0, b, e(20), 0);
      }
      const [va, vb] = await dex1.positionValue(2);
      const pool = await dex1.getPool(0);
      // 价格回到大致相同的位置时，k 增大意味着 LP 价值增长
      expect(va * vb).to.be.greaterThan(e(50) * e(50));

      const balA = await tokenA.balanceOf(bob.address);
      const balB = await tokenB.balanceOf(bob.address);
      await dex1.connect(bob).removeLiquidity(2);
      expect((await tokenA.balanceOf(bob.address)) - balA).to.equal(va);
      expect((await tokenB.balanceOf(bob.address)) - balB).to.equal(vb);
      await expect(dex1.ownerOf(2)).to.be.revert(ethers);
      expect((await dex1.getPool(0)).totalLiquidity).to.equal(pool.totalLiquidity - pos.liquidity);
      const [ids2] = await dex1.getPoolPositions(0);
      expect(ids2).to.deep.equal([1n]);
    });

    it("refunds unused ETH and only lets the NFT owner withdraw", async function () {
      const { alice, bob, tokenA, dex1 } = await networkHelpers.loadFixture(deployFixture);
      const a = await tokenA.getAddress();
      await dex1.connect(alice).createPool(a, ETH, e(100), e(1), { value: e(1) });
      await dex1.connect(bob).addLiquidity(0, e(10), e(1), { value: e(1) }); // 只需要 0.1 ETH
      expect((await dex1.getPool(0)).reserveB).to.equal(e("1.1"));
      expect(await ethers.provider.getBalance(await dex1.getAddress())).to.equal(e("1.1"));
      await expect(dex1.connect(alice).removeLiquidity(2)).to.be.revertedWith("MiniDEX: not owner");
    });

    it("exposes on-chain NFT metadata", async function () {
      const { alice, tokenA, tokenB, dex1 } = await networkHelpers.loadFixture(deployFixture);
      await dex1.connect(alice).createPool(await tokenA.getAddress(), await tokenB.getAddress(), e(1), e(2));
      const uri = await dex1.tokenURI(1);
      const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
      expect(json.name).to.equal("DEX Alpha LP #1");
      expect(json.attributes[2].value).to.equal("TKA/TKB");
      const [ids] = await dex1.getPositionsOf(alice.address);
      expect(ids).to.deep.equal([1n]);
    });
  });

  describe("Arbitrage", function () {
    async function arbFixture() {
      const f = await deployFixture();
      const a = await f.tokenA.getAddress();
      const b = await f.tokenB.getAddress();
      // DEX1: 1 A = 1 B；DEX2: 1 A = 1.2 B（A 在 DEX2 更贵）
      await f.dex1.createPool(a, b, e(100), e(100));
      await f.dex2.createPool(a, b, e(100), e(120));
      return { ...f, a, b };
    }

    it("buys low and sells high atomically", async function () {
      const { arber, dex1, dex2, arb, a, b, tokenB } = await networkHelpers.loadFixture(arbFixture);
      // 用 B 在 DEX1 买入便宜的 A，再到 DEX2 卖出 A 换回更多 B
      const steps = [
        { dex: await dex1.getAddress(), poolId: 0, tokenIn: b },
        { dex: await dex2.getAddress(), poolId: 0, tokenIn: a },
      ];
      const amountIn = e(5);
      const quoted = await arb.quote(steps, amountIn);
      expect(quoted).to.be.greaterThan(amountIn);

      const before = await tokenB.balanceOf(arber.address);
      await expect(arb.connect(arber).executeArbitrage(steps, amountIn, 0))
        .to.emit(arb, "ArbitrageExecuted")
        .withArgs(arber.address, b, amountIn, quoted, quoted - amountIn, 2);
      expect((await tokenB.balanceOf(arber.address)) - before).to.equal(quoted - amountIn);
    });

    it("reverts the whole transaction when not profitable", async function () {
      const { arber, dex1, dex2, arb, a, b, tokenB } = await networkHelpers.loadFixture(arbFixture);
      // 反方向：在贵的地方买，在便宜的地方卖，必然亏损
      const steps = [
        { dex: await dex2.getAddress(), poolId: 0, tokenIn: b },
        { dex: await dex1.getAddress(), poolId: 0, tokenIn: a },
      ];
      const poolBefore = await dex1.getPool(0);
      const before = await tokenB.balanceOf(arber.address);
      await expect(arb.connect(arber).executeArbitrage(steps, e(5), 0)).to.be.revertedWith(
        "Arbitrage: not profitable",
      );
      expect(await tokenB.balanceOf(arber.address)).to.equal(before);
      expect((await dex1.getPool(0)).reserveA).to.equal(poolBefore.reserveA);
    });

    it("supports triangular arbitrage inside one DEX", async function () {
      const { arber, dex1, arb, a, b, tokenC, tokenA } = await networkHelpers.loadFixture(arbFixture);
      const c = await tokenC.getAddress();
      // pool0: A/B 1:1, pool1: B/C 1:1, pool2: C/A 1:1.5 —— 三角环路存在价差
      await dex1.createPool(b, c, e(100), e(100));
      await dex1.createPool(c, a, e(100), e(150));
      const dexAddr = await dex1.getAddress();
      const steps = [
        { dex: dexAddr, poolId: 0, tokenIn: a },
        { dex: dexAddr, poolId: 1, tokenIn: b },
        { dex: dexAddr, poolId: 2, tokenIn: c },
      ];
      const before = await tokenA.balanceOf(arber.address);
      await arb.connect(arber).executeArbitrage(steps, e(5), 0);
      expect(await tokenA.balanceOf(arber.address)).to.be.greaterThan(before);
    });

    it("rejects paths that do not return to the start token", async function () {
      const { arber, dex1, arb, a } = await networkHelpers.loadFixture(arbFixture);
      const steps = [
        { dex: await dex1.getAddress(), poolId: 0, tokenIn: a },
        { dex: await dex1.getAddress(), poolId: 0, tokenIn: a },
      ];
      await expect(arb.connect(arber).executeArbitrage(steps, e(1), 0)).to.be.revertedWith(
        "Arbitrage: broken path",
      );
    });
  });
});
