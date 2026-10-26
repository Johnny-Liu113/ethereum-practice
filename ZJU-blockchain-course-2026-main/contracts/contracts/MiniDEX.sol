// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/// @title MiniDEX —— 基于恒定乘积 AMM（参考 Uniswap V2）的去中心化交易所
/// @notice
///  - 一个合约管理多个交易池，每个池子由 poolId 索引；
///  - address(0) 表示原生 ETH，因此既支持 ERC20/ERC20 池，也支持 ERC20/ETH 池；
///  - 交易价格由 x * y = k 决定，每笔交易收取 feeBps 的手续费，手续费留在池内，
///    使得 LP 份额对应的储备量增长，LP 在撤出流动性时即可获得手续费分红；
///  - 添加流动性时铸造一个 ERC721 NFT 作为流动性凭证，销毁 NFT 即可取回代币和分红。
contract MiniDEX is ERC721Enumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    /// 用 address(0) 表示原生 ETH
    address public constant ETH = address(0);
    /// 首次注入流动性时永久锁定的最小流动性（防止份额操纵攻击，同 Uniswap V2）
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 public constant FEE_DENOMINATOR = 10000;

    /// 交易所名称（部署多个交易所时区分用）
    string public dexName;
    /// 交易手续费，单位为万分之一（30 = 0.3%）
    uint256 public immutable feeBps;

    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;          // 代币 A 储备量
        uint256 reserveB;          // 代币 B 储备量
        uint256 totalLiquidity;    // 流动性份额总量（包含锁定的 MINIMUM_LIQUIDITY）
        uint256 feeAccA;           // 累计收取的代币 A 手续费（仅统计展示用）
        uint256 feeAccB;           // 累计收取的代币 B 手续费（仅统计展示用）
        uint256 swapCount;         // 累计交易次数
        uint256 createdTimestamp;
        address creator;
    }

    /// 每个 LP NFT 对应的流动性头寸信息
    struct Position {
        uint256 poolId;
        uint256 liquidity;         // 持有的流动性份额
        uint256 amountA;           // 注入时存入的代币 A 数量
        uint256 amountB;           // 注入时存入的代币 B 数量
        uint256 createdTimestamp;  // 注入时间
        address provider;          // 最初的流动性提供者
    }

    mapping(uint256 => Pool) public pools;
    uint256 public poolCount;
    /// 代币对 => poolId + 1（0 表示不存在），保证同一交易所内每个代币对只有一个池子
    mapping(bytes32 => uint256) private _pairToPoolIdPlusOne;

    mapping(uint256 => Position) public positions;
    uint256 public nextTokenId = 1;
    /// 每个池子当前所有有效的 NFT（即流动性来源）
    mapping(uint256 => uint256[]) private _poolPositionIds;
    mapping(uint256 => uint256) private _positionIndexInPool;

    event PoolCreated(uint256 indexed poolId, address tokenA, address tokenB, address indexed creator);
    event LiquidityAdded(
        uint256 indexed poolId, uint256 indexed tokenId, address indexed provider,
        uint256 amountA, uint256 amountB, uint256 liquidity
    );
    event LiquidityRemoved(
        uint256 indexed poolId, uint256 indexed tokenId, address indexed provider,
        uint256 amountA, uint256 amountB, uint256 liquidity
    );
    event Swap(
        uint256 indexed poolId, address indexed trader,
        address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 fee
    );

    constructor(string memory dexName_, string memory nftSymbol_, uint256 feeBps_)
        ERC721(string.concat(dexName_, " LP Position"), nftSymbol_)
    {
        require(feeBps_ < 1000, "MiniDEX: fee too high");
        dexName = dexName_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------------------
    // 交易池
    // ------------------------------------------------------------------

    /// @notice 创建交易池并注入初始流动性（初始比例即初始价格）
    /// @dev 若其中一个代币为 ETH，msg.value 必须等于对应的数量
    function createPool(address tokenA, address tokenB, uint256 amountA, uint256 amountB)
        external payable nonReentrant returns (uint256 poolId, uint256 tokenId)
    {
        require(tokenA != tokenB, "MiniDEX: identical tokens");
        require(amountA > 0 && amountB > 0, "MiniDEX: zero amount");
        bytes32 key = _pairKey(tokenA, tokenB);
        require(_pairToPoolIdPlusOne[key] == 0, "MiniDEX: pool exists");

        poolId = poolCount++;
        _pairToPoolIdPlusOne[key] = poolId + 1;
        Pool storage pool = pools[poolId];
        pool.tokenA = tokenA;
        pool.tokenB = tokenB;
        pool.createdTimestamp = block.timestamp;
        pool.creator = msg.sender;
        emit PoolCreated(poolId, tokenA, tokenB, msg.sender);

        _checkEthValue(pool, amountA, amountB);
        tokenId = _depositAndMint(poolId, amountA, amountB);
    }

    /// @notice 向已有池子添加流动性，按当前储备比例计算实际注入量（多余部分不会被扣除）
    /// @param amountADesired 最多愿意注入的代币 A 数量
    /// @param amountBDesired 最多愿意注入的代币 B 数量
    function addLiquidity(uint256 poolId, uint256 amountADesired, uint256 amountBDesired)
        external payable nonReentrant returns (uint256 tokenId)
    {
        Pool storage pool = _getPool(poolId);
        require(amountADesired > 0 && amountBDesired > 0, "MiniDEX: zero amount");
        _checkEthValue(pool, amountADesired, amountBDesired);

        // 与 Uniswap V2 Router 相同：保持当前价格不变
        uint256 amountA = amountADesired;
        uint256 amountB = amountADesired * pool.reserveB / pool.reserveA;
        if (amountB > amountBDesired) {
            amountB = amountBDesired;
            amountA = amountBDesired * pool.reserveA / pool.reserveB;
        }
        require(amountA > 0 && amountB > 0, "MiniDEX: insufficient amount");

        tokenId = _depositAndMint(poolId, amountA, amountB);

        // 退还未使用的 ETH
        uint256 ethUsed = pool.tokenA == ETH ? amountA : (pool.tokenB == ETH ? amountB : 0);
        if (msg.value > ethUsed) {
            _send(ETH, msg.sender, msg.value - ethUsed);
        }
    }

    /// @notice 销毁 LP NFT，按份额取回池中的代币（含累计手续费分红）
    function removeLiquidity(uint256 tokenId)
        external nonReentrant returns (uint256 amountA, uint256 amountB)
    {
        require(ownerOf(tokenId) == msg.sender, "MiniDEX: not owner");
        Position memory pos = positions[tokenId];
        Pool storage pool = pools[pos.poolId];

        amountA = pos.liquidity * pool.reserveA / pool.totalLiquidity;
        amountB = pos.liquidity * pool.reserveB / pool.totalLiquidity;
        require(amountA > 0 && amountB > 0, "MiniDEX: insufficient liquidity burned");

        pool.reserveA -= amountA;
        pool.reserveB -= amountB;
        pool.totalLiquidity -= pos.liquidity;

        _removePositionFromPool(pos.poolId, tokenId);
        delete positions[tokenId];
        _burn(tokenId);

        _send(pool.tokenA, msg.sender, amountA);
        _send(pool.tokenB, msg.sender, amountB);
        emit LiquidityRemoved(pos.poolId, tokenId, msg.sender, amountA, amountB, pos.liquidity);
    }

    // ------------------------------------------------------------------
    // 交易
    // ------------------------------------------------------------------

    /// @notice 在指定池子中用 amountIn 个 tokenIn 兑换另一种代币
    /// @param minAmountOut 滑点保护：实际得到的数量少于此值则 revert
    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external payable nonReentrant returns (uint256 amountOut)
    {
        Pool storage pool = _getPool(poolId);
        require(amountIn > 0, "MiniDEX: zero amount");
        bool aToB = _direction(pool, tokenIn);
        address tokenOut = aToB ? pool.tokenB : pool.tokenA;

        (uint256 reserveIn, uint256 reserveOut) =
            aToB ? (pool.reserveA, pool.reserveB) : (pool.reserveB, pool.reserveA);
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut > 0, "MiniDEX: insufficient output");
        require(amountOut >= minAmountOut, "MiniDEX: slippage exceeded");

        // 收入代币
        if (tokenIn == ETH) {
            require(msg.value == amountIn, "MiniDEX: wrong ETH value");
        } else {
            require(msg.value == 0, "MiniDEX: unexpected ETH");
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // 手续费随 amountIn 一并留在池子里，归 LP 所有
        uint256 fee = amountIn * feeBps / FEE_DENOMINATOR;
        if (aToB) {
            pool.reserveA += amountIn;
            pool.reserveB -= amountOut;
            pool.feeAccA += fee;
        } else {
            pool.reserveB += amountIn;
            pool.reserveA -= amountOut;
            pool.feeAccB += fee;
        }
        pool.swapCount++;

        _send(tokenOut, msg.sender, amountOut);
        emit Swap(poolId, msg.sender, tokenIn, amountIn, tokenOut, amountOut, fee);
    }

    // ------------------------------------------------------------------
    // 查询接口
    // ------------------------------------------------------------------

    /// @notice 预估兑换输出（已扣除手续费）
    function getAmountOut(uint256 poolId, address tokenIn, uint256 amountIn) external view returns (uint256) {
        Pool storage pool = _getPool(poolId);
        bool aToB = _direction(pool, tokenIn);
        return aToB
            ? _getAmountOut(amountIn, pool.reserveA, pool.reserveB)
            : _getAmountOut(amountIn, pool.reserveB, pool.reserveA);
    }

    /// @notice 当前价格：1 个 tokenA 可换多少 tokenB（乘以 1e18）
    function getPrice(uint256 poolId) external view returns (uint256) {
        Pool storage pool = _getPool(poolId);
        return pool.reserveB * 1e18 / pool.reserveA;
    }

    function getPool(uint256 poolId) external view returns (Pool memory) {
        return _getPool(poolId);
    }

    function getAllPools() external view returns (Pool[] memory result) {
        result = new Pool[](poolCount);
        for (uint256 i = 0; i < poolCount; i++) {
            result[i] = pools[i];
        }
    }

    /// @notice 查询某个代币对的池子
    function findPool(address tokenA, address tokenB) external view returns (bool exists, uint256 poolId) {
        uint256 v = _pairToPoolIdPlusOne[_pairKey(tokenA, tokenB)];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    /// @notice 某个池子的全部流动性来源（每个有效的 LP NFT 及其当前持有人）
    function getPoolPositions(uint256 poolId)
        external view returns (uint256[] memory tokenIds, Position[] memory infos, address[] memory owners)
    {
        tokenIds = _poolPositionIds[poolId];
        infos = new Position[](tokenIds.length);
        owners = new address[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            infos[i] = positions[tokenIds[i]];
            owners[i] = ownerOf(tokenIds[i]);
        }
    }

    /// @notice 某个地址持有的全部 LP NFT
    function getPositionsOf(address owner)
        external view returns (uint256[] memory tokenIds, Position[] memory infos)
    {
        uint256 n = balanceOf(owner);
        tokenIds = new uint256[](n);
        infos = new Position[](n);
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = tokenOfOwnerByIndex(owner, i);
            infos[i] = positions[tokenIds[i]];
        }
    }

    /// @notice LP NFT 当前可以取回的代币数量（包含已累计的手续费分红）
    function positionValue(uint256 tokenId) public view returns (uint256 amountA, uint256 amountB) {
        Position storage pos = positions[tokenId];
        require(pos.liquidity > 0, "MiniDEX: no position");
        Pool storage pool = pools[pos.poolId];
        amountA = pos.liquidity * pool.reserveA / pool.totalLiquidity;
        amountB = pos.liquidity * pool.reserveB / pool.totalLiquidity;
    }

    /// @notice 链上生成的 NFT 元数据（JSON，base64 编码），包含池子信息、流动性数量和时间
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory json = string.concat(
            '{"name":"', dexName, " LP #", tokenId.toString(),
            '","description":"MiniDEX liquidity position NFT","attributes":[',
            _poolAttributes(tokenId), ",", _amountAttributes(tokenId), "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ------------------------------------------------------------------
    // 内部函数
    // ------------------------------------------------------------------

    /// 恒定乘积公式（含手续费）：
    /// (reserveIn + amountIn * (1 - fee)) * (reserveOut - amountOut) = reserveIn * reserveOut
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal view returns (uint256)
    {
        require(reserveIn > 0 && reserveOut > 0, "MiniDEX: no liquidity");
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - feeBps);
        return amountInWithFee * reserveOut / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    /// 收取代币、计算流动性份额并铸造 LP NFT
    function _depositAndMint(uint256 poolId, uint256 amountA, uint256 amountB) internal returns (uint256 tokenId) {
        Pool storage pool = pools[poolId];
        _pull(pool.tokenA, amountA);
        _pull(pool.tokenB, amountB);

        uint256 liquidity;
        if (pool.totalLiquidity == 0) {
            liquidity = Math.sqrt(amountA * amountB);
            require(liquidity > MINIMUM_LIQUIDITY, "MiniDEX: initial liquidity too small");
            liquidity -= MINIMUM_LIQUIDITY;
            pool.totalLiquidity = MINIMUM_LIQUIDITY; // 永久锁定
        } else {
            liquidity = Math.min(
                amountA * pool.totalLiquidity / pool.reserveA,
                amountB * pool.totalLiquidity / pool.reserveB
            );
        }
        require(liquidity > 0, "MiniDEX: insufficient liquidity minted");

        pool.reserveA += amountA;
        pool.reserveB += amountB;
        pool.totalLiquidity += liquidity;

        tokenId = nextTokenId++;
        positions[tokenId] = Position({
            poolId: poolId,
            liquidity: liquidity,
            amountA: amountA,
            amountB: amountB,
            createdTimestamp: block.timestamp,
            provider: msg.sender
        });
        _positionIndexInPool[tokenId] = _poolPositionIds[poolId].length;
        _poolPositionIds[poolId].push(tokenId);
        _mint(msg.sender, tokenId);

        emit LiquidityAdded(poolId, tokenId, msg.sender, amountA, amountB, liquidity);
    }

    function _removePositionFromPool(uint256 poolId, uint256 tokenId) internal {
        uint256[] storage ids = _poolPositionIds[poolId];
        uint256 idx = _positionIndexInPool[tokenId];
        uint256 lastId = ids[ids.length - 1];
        ids[idx] = lastId;
        _positionIndexInPool[lastId] = idx;
        ids.pop();
        delete _positionIndexInPool[tokenId];
    }

    function _checkEthValue(Pool storage pool, uint256 amountA, uint256 amountB) internal view {
        uint256 ethNeeded = pool.tokenA == ETH ? amountA : (pool.tokenB == ETH ? amountB : 0);
        require(msg.value == ethNeeded, "MiniDEX: wrong ETH value");
    }

    function _pull(address token, uint256 amount) internal {
        // ETH 已经通过 msg.value 转入，由 _checkEthValue 校验
        if (token != ETH) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == ETH) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "MiniDEX: ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _getPool(uint256 poolId) internal view returns (Pool storage pool) {
        require(poolId < poolCount, "MiniDEX: pool not found");
        pool = pools[poolId];
    }

    function _direction(Pool storage pool, address tokenIn) internal view returns (bool aToB) {
        require(tokenIn == pool.tokenA || tokenIn == pool.tokenB, "MiniDEX: token not in pool");
        return tokenIn == pool.tokenA;
    }

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _symbol(address token) internal view returns (string memory) {
        if (token == ETH) return "ETH";
        try IERC20Metadata(token).symbol() returns (string memory s) {
            return s;
        } catch {
            return token.toHexString();
        }
    }

    function _poolAttributes(uint256 tokenId) internal view returns (string memory) {
        Position storage pos = positions[tokenId];
        Pool storage pool = pools[pos.poolId];
        return string.concat(
            '{"trait_type":"DEX","value":"', dexName, '"},',
            '{"trait_type":"Pool ID","value":', pos.poolId.toString(), "},",
            '{"trait_type":"Pair","value":"', _symbol(pool.tokenA), "/", _symbol(pool.tokenB), '"}'
        );
    }

    function _amountAttributes(uint256 tokenId) internal view returns (string memory) {
        Position storage pos = positions[tokenId];
        return string.concat(
            '{"trait_type":"Liquidity","value":"', pos.liquidity.toString(), '"},',
            '{"trait_type":"Deposited A","value":"', pos.amountA.toString(), '"},',
            '{"trait_type":"Deposited B","value":"', pos.amountB.toString(), '"},',
            '{"trait_type":"Created At","display_type":"date","value":', pos.createdTimestamp.toString(), "}"
        );
    }
}
