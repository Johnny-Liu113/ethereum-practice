import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

describe("MiniDEX", function () {
  async function deployFixture() {
    const [owner, otherAccount] = await ethers.getSigners();
    const miniDEX = await ethers.deployContract("MiniDEX");
    await miniDEX.waitForDeployment();

    return { miniDEX, owner, otherAccount };
  }

  describe("Deployment", function () {
    it("Should return hello world", async function () {
      const { miniDEX } = await networkHelpers.loadFixture(deployFixture);
      expect(await miniDEX.helloworld()).to.equal("hello world");
    });
  });
});
