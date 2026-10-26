// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title 测试用 ETH 水龙头
/// @notice 部署者预先存入 ETH，用户每次可以领取 CLAIM_AMOUNT 的 ETH。
contract EthFaucet {
    uint256 public constant CLAIM_AMOUNT = 1 ether;

    event Claimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function claim() external {
        require(address(this).balance >= CLAIM_AMOUNT, "Faucet: empty");
        (bool ok, ) = msg.sender.call{value: CLAIM_AMOUNT}("");
        require(ok, "Faucet: transfer failed");
        emit Claimed(msg.sender, CLAIM_AMOUNT);
    }
}
