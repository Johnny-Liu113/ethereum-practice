// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./MiniDEX.sol";

/// @title 原子套利合约
/// @notice 沿给定路径依次在一个或多个 MiniDEX 的池子中兑换，路径的起点代币必须等于终点代币。
///         全部兑换在同一笔交易内完成；若最终数量 < 投入数量 + minProfit，整笔交易 revert，
///         所有中间兑换一起回滚，套利者只损失 gas。
///         - 跨交易所套利：A -> B（在 DEX1 低价买入 B），B -> A（在 DEX2 高价卖出 B）
///         - 同交易所三角套利：A -> B -> C -> A
contract Arbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant ETH = address(0);

    struct Step {
        address dex;      // 在哪个交易所
        uint256 poolId;   // 哪个池子
        address tokenIn;  // 本步卖出的代币
    }

    event ArbitrageExecuted(
        address indexed trader, address indexed token,
        uint256 amountIn, uint256 amountOut, uint256 profit, uint256 steps
    );

    receive() external payable {}

    /// @notice 执行套利
    /// @param steps 套利路径
    /// @param amountIn 投入的起始代币数量（若起始代币为 ETH，需通过 msg.value 传入）
    /// @param minProfit 最低利润要求，达不到则整笔交易 revert
    function executeArbitrage(Step[] calldata steps, uint256 amountIn, uint256 minProfit)
        external payable nonReentrant returns (uint256 amountOut, uint256 profit)
    {
        require(steps.length >= 2, "Arbitrage: path too short");
        require(amountIn > 0, "Arbitrage: zero amount");
        address startToken = steps[0].tokenIn;

        if (startToken == ETH) {
            require(msg.value == amountIn, "Arbitrage: wrong ETH value");
        } else {
            require(msg.value == 0, "Arbitrage: unexpected ETH");
            IERC20(startToken).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        address current = startToken;
        uint256 amount = amountIn;
        for (uint256 i = 0; i < steps.length; i++) {
            Step calldata s = steps[i];
            require(s.tokenIn == current, "Arbitrage: broken path");
            MiniDEX dex = MiniDEX(s.dex);
            MiniDEX.Pool memory pool = dex.getPool(s.poolId);
            address tokenOut = s.tokenIn == pool.tokenA ? pool.tokenB : pool.tokenA;

            if (s.tokenIn == ETH) {
                amount = dex.swap{value: amount}(s.poolId, ETH, amount, 0);
            } else {
                IERC20(s.tokenIn).forceApprove(s.dex, amount);
                amount = dex.swap(s.poolId, s.tokenIn, amount, 0);
            }
            current = tokenOut;
        }

        require(current == startToken, "Arbitrage: path must end with start token");
        require(amount >= amountIn + minProfit, "Arbitrage: not profitable");

        amountOut = amount;
        profit = amount - amountIn;
        if (startToken == ETH) {
            (bool ok, ) = msg.sender.call{value: amountOut}("");
            require(ok, "Arbitrage: ETH transfer failed");
        } else {
            IERC20(startToken).safeTransfer(msg.sender, amountOut);
        }
        emit ArbitrageExecuted(msg.sender, startToken, amountIn, amountOut, profit, steps.length);
    }

    /// @notice 链上模拟：按当前储备计算沿路径兑换后的最终数量（不改变状态）
    function quote(Step[] calldata steps, uint256 amountIn) external view returns (uint256 amount) {
        amount = amountIn;
        for (uint256 i = 0; i < steps.length; i++) {
            amount = MiniDEX(steps[i].dex).getAmountOut(steps[i].poolId, steps[i].tokenIn, amount);
        }
    }
}
