const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * THE PROVEN BASELINE MUST NOT CHANGE SILENTLY.
 *
 * baseline/canary-2026-09-13.json is the record of the one successful mainnet canary. Everything
 * downstream — the verifier's defaults, the product layer, the readiness claims — treats it as
 * ground truth. If a deployed address, an immutable role, a split constant or a dependency code
 * hash is edited, that is either a mistake or a different system, and either way it must fail
 * loudly here rather than quietly redefining what "proven" means.
 *
 * Literal expected values are inlined deliberately. A test that reads its expectations from the
 * file it is checking proves nothing.
 */
describe('frozen mainnet baseline', () => {
  const file = path.join(__dirname, '..', '..', 'baseline', 'canary-2026-09-13.json');
  const raw = fs.readFileSync(file, 'utf8');
  const b = JSON.parse(raw);

  it('exists and is marked frozen', () => {
    expect(b.frozen).to.equal(true);
    expect(b.schemaVersion).to.equal(1);
  });

  it('is on Robinhood Chain mainnet', () => {
    expect(b.chainId).to.equal(4663);
  });

  it('pins our deployed contract addresses', () => {
    expect(b.contracts.LaunchpadFactory).to.equal('0xB314cd4731c4F3B4025FCcF5B8E0a3072E8BCbde');
    expect(b.contracts.LaunchpadFamilyLauncher).to.equal('0x4FFbCb9395a839F02f8baeDc02b42CB6E64d9ea6');
    expect(b.contracts.LaunchpadRewards).to.equal('0xC2fE1c6730cc029DcBaC04a04D80baFfC7ed530b');
  });

  it('pins the launchpad, token and Uniswap position', () => {
    expect(b.launchpad.address).to.equal('0x755b0d58Db11c845FB19a28CD5F0717c24098681');
    expect(b.launchpad.policy).to.equal(1); // OPEN
    expect(b.token.address).to.equal('0xe848A44Bb9ab5Fc9788e2E6D64b5CbBDd114d7F4');
    expect(b.token.symbol).to.equal('CANARY');
    expect(b.token.totalSupply).to.equal('1000000000000000000000000000');
    expect(b.pool.positionTokenId).to.equal('2635400');
  });

  it('pins the three immutable economic roles, and they are distinct', () => {
    expect(b.roles.tokenCreator).to.equal('0x2C4AcE643cb9C6a76d9b9FBDe9C38D9732456811');
    expect(b.roles.launchpadOwner).to.equal('0x23fA4a22CE185fb15911ABe7C274a33C05af2b0b');
    expect(b.roles.protocolTreasury).to.equal('0x82Eb14F2FC326DD2E6e16E8A77b56bf45537f1Ef');
    const distinct = new Set([b.roles.tokenCreator, b.roles.launchpadOwner, b.roles.protocolTreasury]
      .map((a) => a.toLowerCase()));
    expect(distinct.size).to.equal(3);
  });

  it('pins the approved 50 / 30 / 20 split', () => {
    expect(b.splitBps).to.deep.equal({ creator: 5000, launchpadOwner: 3000, protocol: 2000 });
  });

  it('pins the launch transaction', () => {
    expect(b.launchTransaction.hash)
      .to.equal('0x2510145068dcdcfe7a266966a31b60a4ab1c984d7c0b8e9d6d042f693ae3c075');
    expect(b.launchTransaction.block).to.equal(62053834);
  });

  it('pins every external Uniswap dependency by address AND code hash', () => {
    const expected = {
      liquidityLauncher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
      instantLaunchStrategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',
      feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
      beneficiaryVault: '0xd35E9CA72F64C7F93BE30fad67524323396B36D7',
      positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
      universalRouter: '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99',
    };
    for (const [name, address] of Object.entries(expected)) {
      expect(b.dependencies[name], `dependency ${name}`).to.not.equal(undefined);
      expect(b.dependencies[name].address).to.equal(address);
      expect(b.dependencies[name].codeHash).to.match(/^0x[0-9a-f]{64}$/i);
    }
  });

  it('records a VERIFIED launch', () => {
    expect(b.verification.status).to.equal('VERIFIED');
    expect(b.verification.checks.filter((c) => !c.passed)).to.deep.equal([]);
  });

  it('reconciles supply exactly, including the external trader', () => {
    const s = b.supplyReconciliation;
    expect(s.exact).to.equal(true);
    const sum = BigInt(s.lockedInPool) + BigInt(s.burned)
      + s.holders.reduce((a, h) => a + BigInt(h.balance), 0n);
    expect(sum).to.equal(BigInt(s.totalSupply));
    // The stranger who bought five blocks after launch is part of the proven record.
    const external = s.holders.filter((h) => h.classification === 'external');
    expect(external.length).to.be.greaterThan(0);
  });

  it('reconciles fees exactly', () => {
    const f = b.feeAccounting;
    expect(f.exact).to.equal(true);
    const credited = BigInt(f.creditedWei.creator) + BigInt(f.creditedWei.launchpadOwner)
      + BigInt(f.creditedWei.protocol);
    expect(credited).to.equal(BigInt(f.claimedTotalWei));
    expect(BigInt(f.unaccountedWei)).to.equal(0n);
    for (const role of ['creator', 'launchpadOwner', 'protocol']) {
      expect(BigInt(f.withdrawnWei[role]) + BigInt(f.pendingWei[role])).to.equal(BigInt(f.creditedWei[role]));
    }
  });

  it('pins the semantic content by hash, so nothing load-bearing can be edited quietly', () => {
    // Hashes only the fields that define the system, not prose. Adding a note is allowed;
    // moving an address, role, split or code hash is not.
    const canonical = JSON.stringify({
      chainId: b.chainId,
      contracts: b.contracts,
      launchpad: { address: b.launchpad.address, owner: b.launchpad.owner, policy: b.launchpad.policy },
      token: { address: b.token.address, totalSupply: b.token.totalSupply, marketLauncher: b.token.marketLauncher },
      pool: { positionTokenId: b.pool.positionTokenId, positionOwner: b.pool.positionOwner, beneficiaryOwner: b.pool.beneficiaryOwner },
      roles: b.roles,
      splitBps: b.splitBps,
      launchTransaction: b.launchTransaction,
      dependencies: b.dependencies,
    });
    const digest = crypto.createHash('sha256').update(canonical).digest('hex');
    expect(digest, 'baseline semantics changed — if this is intentional, it is a NEW baseline')
      .to.equal('3b05bcb217c7de19edd55199c532055ca205834202237420a17d08bbcd67a433');
  });
});
