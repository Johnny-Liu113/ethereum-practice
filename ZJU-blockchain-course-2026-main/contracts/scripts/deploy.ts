import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const miniDEX = await ethers.deployContract("MiniDEX");
  await miniDEX.waitForDeployment();

  console.log(`MiniDEX deployed to ${await miniDEX.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
