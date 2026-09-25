const dns = require('node:dns');
const net = require('node:net');

/**
 * SSRF protection for server-side page fetching. Users can save arbitrary
 * URLs, and the server fetches them from inside our network, so every
 * destination must be a public address — checked on the original URL and on
 * every redirect hop, and enforced again at connect time (see safeLookup) so
 * a DNS answer can't change between the check and the connection.
 */

class BlockedAddressError extends Error {
  constructor(message = 'Blocked: private address') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

// Separate lists per family: BlockList treats an IPv4 address as IPv4-mapped
// when checked against IPv6 subnets, so the ::ffff:0:0/96 rule below would
// otherwise match every IPv4 address.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network", incl. 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]) {
  blocked4.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback (::1), deprecated IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped — never a legitimate public target
  ['64:ff9b::', 96], // NAT64, can embed an internal IPv4
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4, can embed an internal IPv4
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  blocked6.addSubnet(addr, prefix, 'ipv6');
}

function isBlockedIp(address) {
  if (net.isIPv4(address)) return blocked4.check(address, 'ipv4');
  if (net.isIPv6(address)) return blocked6.check(address, 'ipv6');
  return true; // not an IP we can reason about — refuse
}

/** Rejects non-http(s) schemes and literal-IP hostnames. Returns the parsed URL. */
function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError('Blocked: invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedAddressError('Blocked: unsupported URL scheme');
  }
  // URL normalizes odd IPv4 spellings (0x7f.1, 2130706433) to dotted form and
  // wraps IPv6 in brackets, so this catches every literal-IP spelling.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    throw new BlockedAddressError('Blocked: private address (IP-literal host)');
  }
  return parsed;
}

/** Resolves a hostname and returns its addresses, throwing if any is non-public. */
async function resolvePublicAddresses(hostname) {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!results.length) throw new BlockedAddressError('Blocked: host did not resolve');
  for (const { address } of results) {
    if (isBlockedIp(address)) throw new BlockedAddressError();
  }
  return results;
}

/**
 * Drop-in for the `lookup` option of http(s).request. Resolves, validates
 * every returned address, and hands the socket one of those validated
 * addresses — so the IP we checked is the IP we connect to (no rebinding
 * window between validation and connect).
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  resolvePublicAddresses(hostname).then(
    (results) => {
      if (options && options.all) return callback(null, results);
      callback(null, results[0].address, results[0].family);
    },
    (err) => callback(err)
  );
}

module.exports = { BlockedAddressError, assertSafeUrl, resolvePublicAddresses, safeLookup, isBlockedIp };
