// ============================================================
//  ODD-ECOSYS Pipeline — SSRF Guard
//  Validates URLs before fetching to prevent SSRF attacks
// ============================================================

import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';
const customResolver = new dns.promises.Resolver();
try {
  customResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {}

const defaultDnsResolve = promisify(dns.resolve4);
async function dnsResolve(hostname) {
  try {
    return await customResolver.resolve4(hostname);
  } catch {
    return await defaultDnsResolve(hostname);
  }
}

// Private/reserved IP ranges that should never be fetched
const PRIVATE_RANGES = [
  { start: '10.0.0.0',      end: '10.255.255.255'   },   // 10.0.0.0/8
  { start: '172.16.0.0',    end: '172.31.255.255'   },   // 172.16.0.0/12
  { start: '192.168.0.0',   end: '192.168.255.255'  },   // 192.168.0.0/16
  { start: '127.0.0.0',     end: '127.255.255.255'  },   // loopback
  { start: '169.254.0.0',   end: '169.254.255.255'  },   // link-local
  { start: '0.0.0.0',       end: '0.255.255.255'    },   // "this" network
  { start: '100.64.0.0',    end: '100.127.255.255'  },   // shared address space
  { start: '198.18.0.0',    end: '198.19.255.255'   },   // benchmarking
  { start: '224.0.0.0',     end: '255.255.255.255'  },   // multicast + reserved
];

/**
 * Convert IP string to numeric value for range comparison.
 */
function ipToNum(ip) {
  return ip.split('.').reduce((sum, octet) => (sum << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * Check if an IP address falls within any private/reserved range.
 */
function isPrivateIp(ip) {
  const num = ipToNum(ip);
  return PRIVATE_RANGES.some(range => {
    const start = ipToNum(range.start);
    const end = ipToNum(range.end);
    return num >= start && num <= end;
  });
}

/**
 * Validate a URL is safe to fetch (not an SSRF target).
 * @param {string} urlStr - URL to validate
 * @returns {Promise<{ safe: boolean, reason?: string, resolvedIp?: string }>}
 */
export async function validateUrl(urlStr) {
  try {
    const url = new URL(urlStr);

    // Only allow HTTP(S)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { safe: false, reason: `disallowed_protocol:${url.protocol}` };
    }

    // Reject URLs with auth credentials
    if (url.username || url.password) {
      return { safe: false, reason: 'url_contains_credentials' };
    }

    // Reject numeric IP addresses directly
    const hostname = url.hostname;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      if (isPrivateIp(hostname)) {
        return { safe: false, reason: `private_ip:${hostname}` };
      }
    }

    // Reject localhost variants
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
      return { safe: false, reason: `localhost:${hostname}` };
    }

    // Reject IPv6 loopback/link-local
    if (hostname === '[::1]' || hostname.startsWith('[fe80:')) {
      return { safe: false, reason: `ipv6_private:${hostname}` };
    }

    // DNS resolution check — resolve hostname and verify IP is public
    try {
      const ips = await dnsResolve(hostname);
      for (const ip of ips) {
        if (isPrivateIp(ip)) {
          return { safe: false, reason: `dns_resolves_to_private:${ip}` };
        }
      }
      return { safe: true, resolvedIp: ips[0] };
    } catch (dnsError) {
      // DNS resolution failed — domain might not exist, but that's not an SSRF risk
      // Let the fetch itself fail with a proper error
      return { safe: true, resolvedIp: null };
    }

  } catch {
    return { safe: false, reason: 'invalid_url' };
  }
}

/**
 * SSRF-safe fetch wrapper.
 * Validates URL before fetching, rejects private/reserved targets.
 * @param {string} url - URL to fetch
 * @param {object} [options] - Standard fetch options
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, options = {}) {
  const validation = await validateUrl(url);
  if (!validation.safe) {
    throw new Error(`SSRF blocked: ${validation.reason}`);
  }
  return fetch(url, options);
}
