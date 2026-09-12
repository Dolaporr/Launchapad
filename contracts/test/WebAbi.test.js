const { expect } = require('chai');
const { ethers, artifacts } = require('hardhat');
const fs = require('fs');
const path = require('path');

/**
 * web/chain.js hardcodes function selectors and event topics so the browser app needs no build
 * step and no CDN. That is only safe if something checks them against the real compiled ABIs.
 * This is that something: change a contract signature without updating the web app and CI fails.
 */
describe('web/chain.js ABI constants', () => {
  const chainJsPath = path.join(__dirname, '..', '..', 'web', 'chain.js');
  const source = fs.readFileSync(chainJsPath, 'utf8');

  function parseBlock(blockName) {
    const match = source.match(new RegExp(`${blockName}: \\{([\\s\\S]*?)\\n  \\}`));
    expect(match, `${blockName} block not found in web/chain.js`).to.not.equal(null);
    const entries = {};
    const pattern = /'([^']+)':\s*\n?\s*'(0x[0-9a-fA-F]+)'/g;
    let entry = pattern.exec(match[1]);
    while (entry !== null) {
      entries[entry[1]] = entry[2];
      entry = pattern.exec(match[1]);
    }
    return entries;
  }

  it('has a selector for every signature that matches keccak256', () => {
    const selectors = parseBlock('SELECTORS');
    expect(Object.keys(selectors).length).to.be.greaterThan(15);

    for (const [signature, selector] of Object.entries(selectors)) {
      expect(selector, `selector for ${signature}`).to.equal(ethers.id(signature).slice(0, 10));
    }
  });

  it('has event topics that match keccak256', () => {
    const topics = parseBlock('TOPICS');
    expect(Object.keys(topics)).to.have.lengthOf(2);

    for (const [signature, topic] of Object.entries(topics)) {
      expect(topic, `topic0 for ${signature}`).to.equal(ethers.id(signature));
    }
  });

  it('only references functions that actually exist on the deployed contracts', async () => {
    const selectors = parseBlock('SELECTORS');
    const names = ['LaunchpadFactory', 'Launchpad', 'LaunchToken'];

    const known = new Set();
    for (const name of names) {
      const { abi } = await artifacts.readArtifact(name);
      const iface = new ethers.Interface(abi);
      iface.forEachFunction((fn) => known.add(fn.format('sighash')));
    }

    for (const signature of Object.keys(selectors)) {
      expect(known.has(signature), `${signature} is not on any contract ABI`).to.equal(true);
    }
  });

  it('only references events that actually exist', async () => {
    const topics = parseBlock('TOPICS');
    const known = new Set();
    for (const name of ['LaunchpadFactory', 'Launchpad']) {
      const { abi } = await artifacts.readArtifact(name);
      const iface = new ethers.Interface(abi);
      iface.forEachEvent((ev) => known.add(ev.format('sighash')));
    }

    for (const signature of Object.keys(topics)) {
      expect(known.has(signature), `${signature} is not on any contract ABI`).to.equal(true);
    }
  });

  it('targets the verified Robinhood Chain testnet parameters', () => {
    expect(source).to.include('chainId: 46630');
    expect(source).to.include("chainIdHex: '0xb626'");
    expect(source).to.include('https://rpc.testnet.chain.robinhood.com');
    expect(source).to.include('https://explorer.testnet.chain.robinhood.com');
    // 0xb626 must equal 46630 or the wallet switch silently targets the wrong chain.
    expect(parseInt('0xb626', 16)).to.equal(46630);
  });
});
