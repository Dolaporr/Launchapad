const { expect } = require('chai');
const { ethers, network } = require('hardhat');

/**
 * MAINNET-FORK INTEGRATION — runs against the REAL Uniswap Liquidity Launchpad deployed on
 * Robinhood Chain mainnet (chain 4663). No Uniswap contract is mocked here.
 *
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:fork
 *
 * Skipped entirely when FORK_RPC is unset, so the default suite and CI stay hermetic.
 *
 * WHAT IS REAL: the LiquidityLauncher, the InstantLaunchStrategy, the v4 PoolManager and
 * PositionManager, the FeeSplitter, the BeneficiaryVault, the pool that gets created, the LP
 * position, and the beneficiary NFT. Our contracts are deployed fresh onto the forked state.
 *
 * WHAT IS SIMULATED: the *arrival* of trading fees. Rather than executing swaps, fees are
 * injected at the exact boundary Uniswap uses — impersonating the real FeeSplitter to call the
 * real vault's `onAmountsReceived`. So the claim and split run against real vault code, but this
 * does not prove that swaps on the new pool generate fees at the expected rate.
 */
const FORK_RPC = process.env.FORK_RPC;
const describeFork = FORK_RPC ? describe : describe.skip;

// Pinned official addresses, chain 4663.
const UNISWAP = {
  liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};

const POLICY = { OWNER_ONLY: 0, OPEN: 1 };
const PRESET = { STANDARD: 0 };
const SUPPLY = ethers.parseEther('1000000000');

const vaultAbi = [
  'function ownerOf(uint256) view returns (address)',
  'function amounts(uint256) view returns (uint256, uint256)',
  'function onAmountsReceived(uint256 tokenId, uint256 amount0, uint256 amount1)',
  'function nativeFallback() view returns (address)',
];
const positionAbi = ['function nextTokenId() view returns (uint256)', 'function ownerOf(uint256) view returns (address)'];
const splitterAbi = [
  'function getSplits() view returns (tuple(address recipient,uint16 nativeBps,uint16 tokenBps,bool useCallback)[])',
];

describeFork('FORK: real Uniswap Liquidity Launchpad on Robinhood Chain mainnet', function () {
  this.timeout(600000);

  let deployer, padOwner, creator, protocol, keeper;
  let launchpadFactory, launcher, rewards, openPad, closedPad;
  let vault, positionManager;

  before(async () => {
    // Mine one local block so calls execute against local, not historical, state.
    await network.provider.send('evm_mine');
    [deployer, padOwner, creator, protocol, keeper] = await ethers.getSigners();

    // Sanity: we really are forked onto a chain that has the official contracts.
    for (const [name, address] of Object.entries(UNISWAP)) {
      const code = await ethers.provider.getCode(address);
      expect(code.length, `${name} has no code on the fork`).to.be.greaterThan(2);
    }

    vault = new ethers.Contract(UNISWAP.beneficiaryVault, vaultAbi, ethers.provider);
    positionManager = new ethers.Contract(UNISWAP.positionManager, positionAbi, ethers.provider);

    launchpadFactory = await (await ethers.getContractFactory('LaunchpadFactory'))
      .deploy(protocol.address, ethers.ZeroAddress);

    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    launcher = await (await ethers.getContractFactory('LaunchpadFamilyLauncher')).deploy(
      await launchpadFactory.getAddress(),
      UNISWAP.liquidityLauncher,
      UNISWAP.instantLaunchStrategy,
      UNISWAP.beneficiaryVault,
      UNISWAP.positionManager,
      predicted,
    );
    rewards = await (await ethers.getContractFactory('LaunchpadRewards'))
      .deploy(UNISWAP.beneficiaryVault, await launcher.getAddress(), protocol.address);
    expect(await rewards.getAddress()).to.equal(predicted);

    await launchpadFactory.connect(padOwner).createLaunchpad('Fork Open Pad', 'ipfs://fork', PRESET.STANDARD, POLICY.OPEN);
    openPad = await ethers.getContractAt('Launchpad', await launchpadFactory.launchpads(0));
    await launchpadFactory.connect(padOwner).createLaunchpad('Fork Closed Pad', '', PRESET.STANDARD, POLICY.OWNER_ONLY);
    closedPad = await ethers.getContractAt('Launchpad', await launchpadFactory.launchpads(1));
  });

  describe('the official deployment is what we think it is', () => {
    it('is forked onto chain 4663', async () => {
      // The fork reports hardhat's own chain id; the forked STATE is what matters, and the
      // presence of these contracts at these addresses is the proof.
      const splitter = new ethers.Contract(UNISWAP.feeSplitter, splitterAbi, ethers.provider);
      const splits = await splitter.getSplits();
      expect(splits.length).to.equal(2);
    });

    it('the FeeSplitter still sends 40% of the ETH side to the beneficiary vault', async () => {
      const splitter = new ethers.Contract(UNISWAP.feeSplitter, splitterAbi, ethers.provider);
      const splits = await splitter.getSplits();
      const toVault = splits.find((s) => s.recipient.toLowerCase() === UNISWAP.beneficiaryVault.toLowerCase());
      expect(toVault, 'beneficiary vault is not a recipient of the creator-fees splitter').to.not.equal(undefined);
      // If Uniswap ever changes this, our economics change with it — so assert it explicitly.
      expect(Number(toVault.nativeBps)).to.equal(4000);
      expect(Number(toVault.tokenBps)).to.equal(0);
    });

    it('our launcher accepted the official addresses', async () => {
      expect((await launcher.liquidityLauncher()).toLowerCase()).to.equal(UNISWAP.liquidityLauncher.toLowerCase());
      expect((await launcher.instantLaunchStrategy()).toLowerCase()).to.equal(UNISWAP.instantLaunchStrategy.toLowerCase());
      expect((await launcher.beneficiaryVault()).toLowerCase()).to.equal(UNISWAP.beneficiaryVault.toLowerCase());
      expect(await launcher.isCorrectlyWired()).to.equal(true);
    });
  });

  describe('a real launch', () => {
    let token, tokenId, receipt;

    before(async () => {
      const expectedId = await positionManager.nextTokenId();
      const tx = await launcher.connect(creator).launch(await openPad.getAddress(), 'Fork Genesis', 'FGEN');
      receipt = await tx.wait();
      token = await launcher.allTokens(0);
      tokenId = (await launcher.launchOf(token)).positionTokenId;
      expect(tokenId).to.equal(expectedId);
    });

    it('created a real Uniswap v4 position owned by the real FeeSplitter', async () => {
      // The LP NFT is locked in Uniswap's splitter forever — nobody can withdraw the liquidity.
      expect((await positionManager.ownerOf(tokenId)).toLowerCase()).to.equal(UNISWAP.feeSplitter.toLowerCase());
    });

    it('issued the beneficiary NFT to OUR rewards contract', async () => {
      expect((await vault.ownerOf(tokenId)).toLowerCase()).to.equal((await rewards.getAddress()).toLowerCase());
    });

    it('put the entire supply into the pool — no person holds any', async () => {
      const erc20 = await ethers.getContractAt('LaunchToken', token);
      expect(await erc20.totalSupply()).to.equal(SUPPLY);
      expect(await erc20.balanceOf(creator.address)).to.equal(0n);
      expect(await erc20.balanceOf(padOwner.address)).to.equal(0n);
      expect(await erc20.balanceOf(await launcher.getAddress())).to.equal(0n);
      expect(await erc20.balanceOf(await rewards.getAddress())).to.equal(0n);
    });

    it('attributed the stream to creator / pad owner / protocol', async () => {
      const attribution = await rewards.attributionOf(tokenId);
      expect(attribution.tokenCreator).to.equal(creator.address);
      expect(attribution.launchpadOwner).to.equal(padOwner.address);
      expect(attribution.launchpad).to.equal(await openPad.getAddress());
      expect(attribution.token).to.equal(token);
      expect(attribution.registered).to.equal(true);
    });

    it('emitted the launch on chain', async () => {
      const event = receipt.logs
        .map((l) => { try { return launcher.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === 'TokenLaunchedToUniswap');
      expect(event.args.tokenCreator).to.equal(creator.address);
      expect(event.args.launchpadOwner).to.equal(padOwner.address);
    });

    it('enforces OWNER_ONLY against the real launchpad too', async () => {
      await expect(launcher.connect(creator).launch(await closedPad.getAddress(), 'Nope', 'NO'))
        .to.be.revertedWithCustomError(launcher, 'NotAllowedToLaunch');
    });
  });

  describe('the money path, through the real vault', () => {
    let tokenId;
    const FEES = ethers.parseEther('1');

    before(async () => {
      tokenId = (await launcher.launchOf(await launcher.allTokens(0))).positionTokenId;

      // Inject fees exactly where Uniswap's FeeSplitter does: send the native leg to the vault
      // and notify it. Impersonating the real splitter means the real vault's own accounting and
      // access control are exercised.
      await network.provider.send('hardhat_impersonateAccount', [UNISWAP.feeSplitter]);
      await network.provider.send('hardhat_setBalance', [
        UNISWAP.feeSplitter, '0x' + ethers.parseEther('1000').toString(16),
      ]);
      const asSplitter = await ethers.getSigner(UNISWAP.feeSplitter);

      await asSplitter.sendTransaction({ to: UNISWAP.beneficiaryVault, value: FEES });
      await new ethers.Contract(UNISWAP.beneficiaryVault, vaultAbi, asSplitter)
        .onAmountsReceived(tokenId, FEES, 0);

      await network.provider.send('hardhat_stopImpersonatingAccount', [UNISWAP.feeSplitter]);
    });

    it('the real vault attributes the fees to our position', async () => {
      const [native] = await vault.amounts(tokenId);
      expect(native).to.equal(FEES);
    });

    it('collectAndSplit claims from the real vault and splits 50 / 30 / 20', async () => {
      await expect(rewards.connect(keeper).collectAndSplit(tokenId))
        .to.emit(rewards, 'RewardsSplit')
        .withArgs(tokenId, FEES, ethers.parseEther('0.5'), ethers.parseEther('0.3'), ethers.parseEther('0.2'));

      expect(await rewards.pending(creator.address)).to.equal(ethers.parseEther('0.5'));
      expect(await rewards.pending(padOwner.address)).to.equal(ethers.parseEther('0.3'));
      expect(await rewards.pending(protocol.address)).to.equal(ethers.parseEther('0.2'));
      expect(await rewards.pending(keeper.address)).to.equal(0n);
    });

    it('every party can actually withdraw real ETH', async () => {
      await expect(rewards.connect(creator).withdraw())
        .to.changeEtherBalance(creator, ethers.parseEther('0.5'));
      await expect(rewards.withdrawFor(padOwner.address))
        .to.changeEtherBalance(padOwner, ethers.parseEther('0.3'));
      await expect(rewards.withdrawFor(protocol.address))
        .to.changeEtherBalance(protocol, ethers.parseEther('0.2'));

      expect(await rewards.totalPending()).to.equal(0n);
      expect(await ethers.provider.getBalance(await rewards.getAddress())).to.equal(0n);
    });

    it('conserves every wei on an awkward amount', async () => {
      const odd = 123456789n;
      await network.provider.send('hardhat_impersonateAccount', [UNISWAP.feeSplitter]);
      const asSplitter = await ethers.getSigner(UNISWAP.feeSplitter);
      await asSplitter.sendTransaction({ to: UNISWAP.beneficiaryVault, value: odd });
      await new ethers.Contract(UNISWAP.beneficiaryVault, vaultAbi, asSplitter).onAmountsReceived(tokenId, odd, 0);
      await network.provider.send('hardhat_stopImpersonatingAccount', [UNISWAP.feeSplitter]);

      await rewards.collectAndSplit(tokenId);
      const sum = (await rewards.pending(creator.address))
        + (await rewards.pending(padOwner.address))
        + (await rewards.pending(protocol.address));
      expect(sum).to.equal(odd);
      expect(await ethers.provider.getBalance(await rewards.getAddress())).to.equal(odd);
    });
  });

  describe('many launches through one rewards contract', () => {
    it('services a second launch from a different creator independently', async () => {
      const [, , , , , second] = await ethers.getSigners();
      await launcher.connect(second).launch(await openPad.getAddress(), 'Fork Second', 'FSEC');

      const tokenB = await launcher.allTokens(1);
      const idB = (await launcher.launchOf(tokenB)).positionTokenId;
      const idA = (await launcher.launchOf(await launcher.allTokens(0))).positionTokenId;

      expect(idB).to.not.equal(idA);
      expect((await vault.ownerOf(idB)).toLowerCase()).to.equal((await rewards.getAddress()).toLowerCase());
      expect((await rewards.attributionOf(idB)).tokenCreator).to.equal(second.address);
      expect((await rewards.attributionOf(idA)).tokenCreator).to.equal(creator.address);
      expect(await launcher.tokenCount()).to.equal(2);
    });
  });
});
