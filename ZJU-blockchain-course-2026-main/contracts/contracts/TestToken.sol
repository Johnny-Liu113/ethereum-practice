// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title 测试用 ERC20 代币
/// @notice 任何人都可以调用 faucet() 免费领取一定数量的代币，用于模拟多个用户。
contract TestToken is ERC20 {
    /// 每次领取的数量（18 位精度下的 1000 个代币）
    uint256 public constant FAUCET_AMOUNT = 1000 ether;

    event FaucetClaimed(address indexed user, uint256 amount);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice 领取测试代币
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }
}
