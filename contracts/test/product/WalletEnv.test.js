const { expect } = require('chai');
const path = require('path');

/**
 * How a visitor reaches a wallet.
 *
 * The property under test: THERE IS ALWAYS A NEXT STEP. The bug this replaces
 * rendered "No wallet detected" with nothing to press, which on mobile Safari is
 * every single visitor. Every branch below must terminate in either a connect
 * call, a hand-off link, or a stated reason a person can act on.
 */
describe('wallet environment (connection routing)', () => {
  let connectionEnvironment; let linkFor; let walletLinks; let platformOf;
  let isInWalletBrowser; let ROUTE; let PLATFORM;

  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36';
  const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  const AT = { href: 'https://ai-fun.launchpad.family/launch' };

  before(async () => {
    const mod = await import(
      `file://${path.join(__dirname, '..', '..', '..', 'web', 'walletEnv.js')}`
    );
    ({
      connectionEnvironment, linkFor, walletLinks, platformOf, isInWalletBrowser, ROUTE, PLATFORM,
    } = mod);
  });

  describe('platform detection', () => {
    it('identifies the three platforms', () => {
      expect(platformOf(IPHONE)).to.equal(PLATFORM.IOS);
      expect(platformOf(ANDROID)).to.equal(PLATFORM.ANDROID);
      expect(platformOf(DESKTOP)).to.equal(PLATFORM.DESKTOP);
    });

    // iPadOS 13+ claims to be a Mac. Without the touch check an iPad visitor is
    // told to install a desktop extension, which cannot be done there.
    it('sees through an iPad pretending to be a Mac', () => {
      expect(platformOf(IPAD, { maxTouchPoints: 5 })).to.equal(PLATFORM.IOS);
      expect(platformOf(IPAD, { maxTouchPoints: 0 })).to.equal(PLATFORM.DESKTOP);
    });

    it('recognises wallet in-app browsers', () => {
      expect(isInWalletBrowser(`${IPHONE} MetaMaskMobile`)).to.equal(true);
      expect(isInWalletBrowser('Mozilla/5.0 CoinbaseWallet/1.0')).to.equal(true);
      expect(isInWalletBrowser(DESKTOP)).to.equal(false);
    });
  });

  describe('an injected wallet always wins', () => {
    it('routes straight to connect, on any platform', () => {
      for (const ua of [IPHONE, ANDROID, DESKTOP]) {
        const env = connectionEnvironment({ hasInjected: true, userAgent: ua, location: AT });
        expect(env.route).to.equal(ROUTE.INJECTED);
        expect(env.links).to.have.lengthOf(0);
      }
    });
  });

  describe('mobile without a wallet gets a hand-off, not a dead end', () => {
    it('offers wallet links on iOS', () => {
      const env = connectionEnvironment({ userAgent: IPHONE, location: AT });
      expect(env.route).to.equal(ROUTE.DEEP_LINK);
      expect(env.links.length).to.be.greaterThan(0);
      env.links.forEach((l) => expect(l.href).to.match(/^https:\/\//));
    });

    it('offers wallet links on Android', () => {
      const env = connectionEnvironment({ userAgent: ANDROID, location: AT });
      expect(env.route).to.equal(ROUTE.DEEP_LINK);
      expect(env.links.length).to.be.greaterThan(0);
    });

    // Trust removed its in-app dApp browser on iOS in May 2021. Offering it there
    // sends the visitor to an app that cannot open the page.
    it('never offers Trust Wallet on iOS, but does on Android', () => {
      expect(linkFor('trust', AT, PLATFORM.IOS)).to.equal(null);
      expect(linkFor('trust', AT, PLATFORM.ANDROID)).to.match(/^https:\/\/link\.trustwallet\.com/);

      const ios = walletLinks(AT, PLATFORM.IOS).map((w) => w.id);
      expect(ios).to.not.include('trust');
      expect(walletLinks(AT, PLATFORM.ANDROID).map((w) => w.id)).to.include('trust');
    });

    it('builds each vendor link in the documented shape', () => {
      // MetaMask takes host+path with NO scheme; including https:// breaks it.
      expect(linkFor('metamask', AT, PLATFORM.IOS))
        .to.equal('https://metamask.app.link/dapp/ai-fun.launchpad.family/launch');
      // Coinbase takes a percent-encoded absolute URL.
      expect(linkFor('coinbase', AT, PLATFORM.IOS))
        .to.equal(`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(AT.href)}`);
    });

    it('carries the query string through, so a deep link lands on the same page', () => {
      const withQuery = { href: 'https://ai-fun.launchpad.family/t/0xabc?refresh=1' };
      expect(linkFor('metamask', withQuery, PLATFORM.ANDROID))
        .to.equal('https://metamask.app.link/dapp/ai-fun.launchpad.family/t/0xabc?refresh=1');
    });

    it('refuses to hand a non-http URL to another app', () => {
      expect(linkFor('metamask', { href: 'javascript:alert(1)' }, PLATFORM.IOS)).to.equal(null);
      expect(linkFor('metamask', { href: 'file:///etc/passwd' }, PLATFORM.IOS)).to.equal(null);
      expect(linkFor('metamask', { href: '' }, PLATFORM.IOS)).to.equal(null);
    });
  });

  describe('states that cannot be solved by a link say why', () => {
    // Wallets refuse to inject over plain http. Offering a hand-off would loop
    // the visitor back to a page that still cannot connect.
    it('names an insecure page as the blocker, and offers no links', () => {
      const env = connectionEnvironment({
        userAgent: IPHONE, location: { href: 'http://launchpad.family/' }, secureContext: false,
      });
      expect(env.route).to.equal(ROUTE.MANUAL);
      expect(env.reason).to.equal('insecure_context');
      expect(env.links).to.have.lengthOf(0);
    });

    it('does not tell a wallet browser to open itself again', () => {
      const env = connectionEnvironment({
        hasInjected: false, userAgent: `${IPHONE} MetaMaskMobile`, location: AT,
      });
      expect(env.route).to.equal(ROUTE.MANUAL);
      expect(env.reason).to.equal('wallet_browser_no_provider');
      expect(env.links).to.have.lengthOf(0);
    });

    it('sends desktop visitors to an extension rather than a phone link', () => {
      const env = connectionEnvironment({ userAgent: DESKTOP, location: AT });
      expect(env.route).to.equal(ROUTE.MANUAL);
      expect(env.reason).to.equal('desktop_no_extension');
      expect(env.links).to.have.lengthOf(0);
    });
  });

  it('every environment terminates in an action or a stated reason', () => {
    const cases = [
      { hasInjected: true, userAgent: DESKTOP },
      { hasInjected: false, userAgent: DESKTOP },
      { hasInjected: false, userAgent: IPHONE },
      { hasInjected: false, userAgent: ANDROID },
      { hasInjected: false, userAgent: `${ANDROID} Trust/1.0` },
      { hasInjected: false, userAgent: IPHONE, secureContext: false },
      { hasInjected: false, userAgent: '' },
    ];
    for (const c of cases) {
      const env = connectionEnvironment({ ...c, location: AT });
      const actionable = env.route === ROUTE.INJECTED
        || env.links.length > 0
        || Boolean(env.reason);
      expect(actionable, `no way forward for ${JSON.stringify(c)}`).to.equal(true);
    }
  });
});
